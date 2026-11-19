import test from 'node:test';
import assert from 'node:assert/strict';
import * as gen from '../functions/api/generate.js';
import * as share from '../functions/api/share.js';
import { SCENARIOS } from '../public/js/examples.js';
import { lint } from './lint.js';

const post = (url, body, init = {}) => new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
const kv = () => { const m = new Map(); return { m, put: async (k, v) => { m.set(k, v); }, get: async (k) => m.get(k) ?? null }; };

test('POST /api/generate returns script + warnings as JSON and lints clean', async () => {
  const res = await gen.onRequestPost({ request: post('https://x/api/generate', { ...SCENARIOS.pccDual(), version: '6' }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /json/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(lint(body.script, '6'), []);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('?format=rsc returns text/plain; invalid config returns 400 JSON errors', async () => {
  let res = await gen.onRequestPost({ request: post('https://x/api/generate?format=rsc', { ...SCENARIOS.simple(), version: '7' }) });
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(await res.text(), /^# MikroTik Forge/);
  res = await gen.onRequestPost({ request: post('https://x/api/generate?format=rsc', { ...SCENARIOS.simple(), version: '9' }) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test('generate rejects bad bodies safely', async () => {
  for (const [body, status] of [['not json', 400], ['[]', 400], ['null', 400], ['x'.repeat(70000), 413]]) {
    const res = await gen.onRequestPost({ request: post('https://x/api/generate', body) });
    assert.equal(res.status, status, String(body).slice(0, 20));
  }
  const res = await gen.onRequestOptions();
  assert.equal(res.status, 204);
});

test('hostile structures never crash the generator endpoint (always JSON, never 5xx)', async () => {
  const nasty = [{ wans: 'x' }, { wans: [null] }, { vlans: [1, 2] }, { lan: null }, { qos: { gaming: 5 } }, { firewall: { portForwards: [null, 'a'] } }, { system: { dns: { a: 1 } } }, { __proto__: { polluted: 1 }, constructor: { prototype: { x: 1 } } }, JSON.parse('{"__proto__":{"polluted":true}}')];
  for (const n of nasty) {
    const res = await gen.onRequestPost({ request: post('https://x/api/generate', n) });
    assert.ok(res.status < 500, JSON.stringify(n));
    await res.json();
  }
  assert.equal({}.polluted, undefined, 'prototype pollution');
});

test('share: stores scrubbed config, returns id, round-trips, validates id', async () => {
  const env = { SHARES: kv() };
  const cfg = { ...SCENARIOS.pppoeVlan(), version: '7' };
  const res = await share.onRequestPost({ request: post('https://x/api/share', cfg), env });
  const { id } = await res.json();
  assert.match(id, /^[A-Za-z0-9]{10}$/);
  const got = await (await share.onRequestGet({ request: new Request(`https://x/api/share?id=${id}`), env })).json();
  assert.equal(got.wans[0].pppoeUser, 'user@isp');
  assert.equal(got.wans[0].pppoePass, '', 'password must never be stored');
  assert.equal((await share.onRequestGet({ request: new Request('https://x/api/share?id=../etc'), env })).status, 400);
  assert.equal((await share.onRequestGet({ request: new Request('https://x/api/share?id=aaaaaaaaaa'), env })).status, 404);
});

test('share without KV binding answers 501 (UI falls back to #c= links)', async () => {
  assert.equal((await share.onRequestPost({ request: post('https://x/api/share', {}), env: {} })).status, 501);
  assert.equal((await share.onRequestGet({ request: new Request('https://x/api/share?id=aaaaaaaaaa'), env: {} })).status, 501);
});
