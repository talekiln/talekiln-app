'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const legacy = require('../src/kernel/legacy');
const { seededDb } = require('./helpers/kernelDb');

const composeSize = (db, ep) => {
  const { graph } = store.openProject(db, ep);
  return graph.nodes[kernel.composeId(graph)].params.size;
};
const setAspect = (db, ep, aspect) => {
  const drama = db.prepare('SELECT d.id, d.metadata FROM dramas d JOIN episodes e ON e.drama_id = d.id WHERE e.id = ?').get(ep);
  const meta = drama.metadata ? JSON.parse(drama.metadata) : {};
  if (aspect === undefined) delete meta.aspect_ratio; else meta.aspect_ratio = aspect;
  db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), drama.id);
};

describe('compose node size follows the project aspect ratio', () => {
  for (const [aspect, size] of [['16:9', '1920x1080'], ['9:16', '1080x1920'], ['1:1', '1080x1080'], ['4:3', '1440x1080'], ['3:4', '1080x1440'], ['16：9', '1920x1080']]) {
    it(`${aspect} -> ${size}`, async () => {
      const { db, episodeId } = await seededDb();
      setAspect(db, episodeId, aspect);
      legacy.importLegacy(db, episodeId);
      assert.equal(composeSize(db, episodeId), size);
      kernel.validateGraph(store.openProject(db, episodeId).graph);
    });
  }

  it('an unknown or missing aspect keeps the kernel default', async () => {
    for (const aspect of ['5:4', '', undefined]) {
      const { db, episodeId } = await seededDb();
      setAspect(db, episodeId, aspect);
      legacy.importLegacy(db, episodeId);
      assert.equal(composeSize(db, episodeId), kernel.defaultParams('compose').size);
    }
  });

  it('composeSizeFor is a pure lookup', () => {
    assert.equal(legacy.composeSizeFor('16:9'), '1920x1080');
    assert.equal(legacy.composeSizeFor(null), null);
  });
});
