const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { createSpendService } = require('../src/spend');
const { toCsv } = require('../src/spend/csv');
const spendRoutes = require('../src/routes/spend');

const mig = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');
const T0 = new Date(2026, 9, 15, 12, 0, 0).getTime();

function setup() {
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spendrep-')), 't.db'));
  db.exec(mig('23_ai_tasks.sql'));
  db.exec(mig('25_spend_log.sql'));
  db.exec(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
  const spend = createSpendService(db, { now: () => T0 });
  const ins = db.prepare(`INSERT INTO spend_log (task_id, provider, kind, model, project_id, currency, estimated, actual, day, created_at)
    VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?, 1)`);
  ins.run('t1', 'bailian', 'video', 'wan2.6-t2v', '7', 6, null, '2026-10-01');
  ins.run('t2', 'bailian', 'image', 'z-image-turbo', '7', 0.1, 0.12, '2026-10-02');
  ins.run('t3', 'ark', 'video', 'seedance', '8', 2, null, '2026-10-02');
  ins.run('t4', 'ark', 'tts', null, null, 0.5, null, '2026-09-30');
  ins.run('=cmd', 'ark', 'image', '=HYPERLINK("x")', '8', 1, null, '2026-10-03');
  return { db, spend };
}

describe('spend report', () => {
  it('summary groups by model with provider', () => {
    const { spend } = setup();
    const s = spend.summary({ from: '2026-10-01' });
    const m = Object.fromEntries(s.by_model.map((r) => [`${r.provider}/${r.model}`, r]));
    assert.equal(m['bailian/wan2.6-t2v'].cost, 6);
    assert.equal(m['bailian/z-image-turbo'].cost, 0.12); // actual wins over estimate
    assert.equal(s.by_model.length, 4);
    assert.equal(s.by_day.length, 3);
    assert.equal(s.total.cost, 9.12);
    // rows without a model keep a null model
    const all = spend.summary({ from: '2026-09-01' });
    assert.ok(all.by_model.some((r) => r.provider === 'ark' && r.model === null));
  });

  it('listTasks filters, orders and paginates', () => {
    const { spend } = setup();
    const all = spend.listTasks({});
    assert.equal(all.total, 5);
    assert.equal(all.items[0].day, '2026-10-03');
    assert.equal(spend.listTasks({ from: '2026-10-02', to: '2026-10-02' }).total, 2);
    assert.equal(spend.listTasks({ project_id: '7' }).total, 2);
    const page = spend.listTasks({ limit: 2, offset: 4 });
    assert.equal(page.items.length, 1);
    assert.equal(spend.listTasks({ project_id: '7' }).items.find((r) => r.task_id === 't2').cost, 0.12);
  });

  it('csv has BOM, header, quoting and formula guard', () => {
    const csv = toCsv([
      { day: '2026-10-01', task_id: 'a,b', provider: 'x', kind: 'k', model: '=1+1', project_id: null, currency: 'CNY', estimated: 1.5, actual: null, cost: 1.5 },
      { day: '2026-10-01', task_id: 'q"t', provider: 'x', kind: 'k', model: 'm', project_id: '3', currency: 'CNY', estimated: -1, actual: null, cost: -1 },
    ]);
    assert.ok(csv.startsWith('﻿日期,任务ID'));
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[1], '2026-10-01,"a,b",x,k,\'=1+1,,CNY,1.5,,1.5');
    assert.match(lines[2], /"q""t"/);
    assert.match(lines[2], /,-1,,-1$/); // numbers are not mangled
  });

  it('routes: tasks and export', async () => {
    const { spend } = setup();
    const sp = spendRoutes(spend, { error() {} });
    const app = express();
    app.get('/spend/tasks', sp.tasks);
    app.get('/spend/export', sp.exportCsv);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let r = await fetch(base + '/spend/tasks?from=2026-10-02&to=2026-10-02');
      let b = await r.json();
      assert.equal(b.data.total, 2);
      assert.equal((await fetch(base + '/spend/tasks?from=nope')).status, 400);
      r = await fetch(base + '/spend/export?from=2026-10-01');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/csv/);
      assert.match(r.headers.get('content-disposition'), /attachment; filename="spend-2026-10-01_now\.csv"/);
      const text = await r.text();
      assert.equal(text.trim().split('\r\n').length, 5); // header + 4 rows from Oct
      assert.equal((await fetch(base + '/spend/export?to=x')).status, 400);
    } finally { server.close(); }
  });
});
