const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AI_DEFAULT_LIMIT = '2';
const limiter = require('../src/aiLimiter');

test.beforeEach(() => limiter._resetMemory());

test('normalizeIp maps IPv4-mapped and loopback addresses', () => {
  assert.equal(limiter.normalizeIp('::ffff:10.0.0.7'), '10.0.0.7');
  assert.equal(limiter.normalizeIp('::1'), '127.0.0.1');
  assert.equal(limiter.normalizeIp(undefined), '127.0.0.1');
});

test('getClientIp uses req.ip and ignores raw X-Forwarded-For', () => {
  const req = { ip: '203.0.113.9', headers: { 'x-forwarded-for': '1.2.3.4' } };
  assert.equal(limiter.getClientIp(req), '203.0.113.9');
});

test('reserveAiUsage enforces the limit and releaseAiUsage refunds', async () => {
  const ip = '198.51.100.1';
  assert.equal((await limiter.reserveAiUsage(ip)).allowed, true);
  assert.equal((await limiter.reserveAiUsage(ip)).allowed, true);
  const denied = await limiter.reserveAiUsage(ip);
  assert.equal(denied.allowed, false);
  assert.equal(denied.used, 2);

  await limiter.releaseAiUsage(ip);
  assert.equal((await limiter.reserveAiUsage(ip)).allowed, true);
});

test('custom per-IP limits and a global limit of 0 are honored', async () => {
  await limiter.updateIpLimit('198.51.100.2', 5);
  assert.equal((await limiter.getStatus('198.51.100.2')).limit, 5);

  await limiter.updateGlobalLimit(0);
  assert.equal((await limiter.reserveAiUsage('198.51.100.3')).allowed, false);
});

test('invalid admin limits are rejected', async () => {
  await assert.rejects(limiter.updateGlobalLimit('abc'), /whole number/);
  await assert.rejects(limiter.updateIpLimit('198.51.100.4', -1), /whole number/);
});
