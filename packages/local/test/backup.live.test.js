'use strict';
// P3-K 云备份：对真实 S3 兼容服务（CI 里是一次性的 MinIO 容器）跑一遍客户端与整条备份 -> 列表 -> 恢复 -> 清理链路。
// 只有设置了下面四个环境变量才运行，否则整组跳过。不要把真实凭据写进任何文件；CI 用的是容器里的一次性账号。
//   TALEKILN_TEST_S3_ENDPOINT    例如 http://127.0.0.1:9000
//   TALEKILN_TEST_S3_BUCKET      测试桶（设置 TALEKILN_TEST_S3_CREATE_BUCKET=1 时不存在就建）
//   TALEKILN_TEST_S3_ACCESS_KEY / TALEKILN_TEST_S3_SECRET_KEY
//   TALEKILN_TEST_S3_REGION      可选，默认 us-east-1
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const s3 = require('../src/backup/s3');
const { createBackupService } = require('../src/backup/service');
const secrets = require('../src/secrets');
const { seededDb, log } = require('./helpers/kernelDb');

const env = process.env;
const ENABLED = !!(env.TALEKILN_TEST_S3_ENDPOINT && env.TALEKILN_TEST_S3_BUCKET && env.TALEKILN_TEST_S3_ACCESS_KEY && env.TALEKILN_TEST_S3_SECRET_KEY);

const opts = ENABLED ? {} : { skip: 'TALEKILN_TEST_S3_* 未设置，跳过真实对象存储测试' };

describe('backup live (real S3-compatible storage)', () => {
  const cfg = {
    endpoint: env.TALEKILN_TEST_S3_ENDPOINT, bucket: env.TALEKILN_TEST_S3_BUCKET, accessKey: env.TALEKILN_TEST_S3_ACCESS_KEY, secretKey: env.TALEKILN_TEST_S3_SECRET_KEY,
    region: env.TALEKILN_TEST_S3_REGION || 'us-east-1',
  };
  const run = crypto.randomBytes(6).toString('hex');
  const prefix = `talekiln-ci/${run}`;
  let client;

  before(async () => {
    if (!ENABLED) return;
    client = s3.createS3Client(cfg);
    if (env.TALEKILN_TEST_S3_CREATE_BUCKET === '1') await client.createBucket();
    await client.headBucket();
  });

  after(async () => {
    if (!ENABLED) return;
    // 清掉本次的所有对象
    try { for (const o of await client.listAll(`${prefix}/`)) await client.deleteObject(o.key); } catch (_) { /* 尽力 */ }
  });

  it('client: put / get / head / list (paged) / delete, CJK and spaces in keys, wrong secret rejected', opts, async () => {
    const keys = ['a.txt', 'b c.txt', '中文 名.json', 'sub/dir/d.bin'].map((k) => `${prefix}/client/${k}`);
    for (const k of keys) await client.putObject(k, Buffer.from(`live:${k}`), { contentType: 'text/plain' });
    assert.equal((await client.getObject(keys[2])).body.toString(), `live:${keys[2]}`);
    assert.equal((await client.headObject(keys[3])).contentLength, `live:${keys[3]}`.length);
    assert.equal(await client.headObject(`${prefix}/client/none`), null);
    await assert.rejects(client.getObject(`${prefix}/client/none`), (e) => e.code === 'NOT_FOUND' && e.s3Code === 'NoSuchKey');
    const p1 = await client.listObjectsV2(`${prefix}/client/`, { maxKeys: 3 });
    assert.equal(p1.isTruncated, true);
    assert.ok(p1.nextContinuationToken);
    const p2 = await client.listObjectsV2(`${prefix}/client/`, { maxKeys: 3, continuationToken: p1.nextContinuationToken });
    assert.deepEqual([...p1.contents, ...p2.contents].map((o) => o.key).sort(), [...keys].sort());
    assert.deepEqual((await client.listAll(`${prefix}/client/`, { maxKeys: 2 })).map((o) => o.key).sort(), [...keys].sort());
    const bad = s3.createS3Client({ ...cfg, secretKey: 'definitely-wrong' });
    await assert.rejects(bad.listObjectsV2(`${prefix}/`), (e) => e.code === 'BACKUP_AUTH');
    for (const k of keys) await client.deleteObject(k);
    assert.equal((await client.listAll(`${prefix}/client/`)).length, 0);
  });

  it('service: backup -> list -> restore -> prune -> delete against the real bucket', opts, async () => {
    const seeded = await seededDb({ withTimeline: false });
    secrets.setSecretStore(new secrets.FileSecretStore({ cipher: secrets.createAesCipher(Buffer.alloc(32, 3)) }));
    const svc = createBackupService({ db: seeded.db, config: { storage: { local_path: path.join(seeded.dir, 'storage') } }, log, appVersion: 'live-test' });
    svc.putSettings({ endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, prefix, access_key: cfg.accessKey, secret_key: cfg.secretKey, keep: 1 });
    const t = await svc.testConnection();
    assert.equal(t.ok, true);
    const dramaId = seeded.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(seeded.episodeId).drama_id;
    const a = await svc.backupDrama(dramaId);
    await new Promise((r) => setTimeout(r, 1100)); // 时间戳到毫秒，保证不同键
    const b = await svc.backupDrama(dramaId);
    assert.notEqual(a.run.key, b.run.key);
    const list = await svc.listSnapshots(dramaId);
    assert.equal(list.source, 's3');
    assert.deepEqual(list.items.map((x) => x.key), [b.run.key]); // keep = 1：旧的已被清掉
    assert.equal(list.items[0].sha256, b.run.sha256);
    const head = await client.headObject(a.run.key);
    assert.equal(head, null);
    const r = await svc.restore(b.run.key);
    assert.match(r.title, /导入1$/);
    assert.equal(r.sha256, b.run.sha256);
    assert.equal(seeded.db.prepare('SELECT COUNT(*) n FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE e.drama_id = ?').get(r.drama_id).n, 5);
    await svc.deleteSnapshot(b.run.key);
    assert.deepEqual((await svc.listSnapshots(dramaId)).items, []);
  });
});
