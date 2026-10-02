const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { legacyGuard } = require('../src/routes/legacySpendGuard');

const fakeRes = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, setHeader() {}, end(b) { this.body = b; }, send(b) { this.body = b; return this; } });

describe('legacy create spend guard', () => {
  it('passes when no spend service or under caps', () => {
    assert.equal(legacyGuard(null, 'image')({ body: {} }, fakeRes()), true);
    const spend = { check: () => ({ ok: true, est: { known: true } }) };
    assert.equal(legacyGuard(spend, 'video')({ body: { duration: 5 } }, fakeRes()), true);
  });
  it('blocks with 402 when a cap would be exceeded', () => {
    const spend = { check: () => ({ ok: false, message: '超过单次上限', est: { known: true } }) };
    const res = fakeRes();
    assert.equal(legacyGuard(spend, 'video')({ body: { provider: 'bailian', duration: 15 } }, res), false);
    assert.equal(res.code, 402);
  });
  it('falls back to bailian prices for a provider with no price entry', () => {
    const seen = [];
    const spend = { check: (s) => { seen.push(s.provider); return { ok: true, est: { known: s.provider === 'bailian' } }; } };
    legacyGuard(spend, 'image')({ body: { provider: 'chatfire' } }, fakeRes());
    assert.deepEqual(seen, ['chatfire', 'bailian']);
  });
});
