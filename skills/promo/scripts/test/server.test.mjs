import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serveDirs } from '../lib/server.js';
import { tmpDir } from './helpers.mjs';

const BODY = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
let server;

before(async () => {
  const dir = tmpDir('server');
  fs.writeFileSync(path.join(dir, 'clip.webm'), BODY);
  server = await serveDirs([{ prefix: '/', root: dir }]);
});
after(async () => { await server.close(); });

const get = async (range) => {
  const res = await fetch(`${server.origin}/clip.webm`, { headers: range ? { range } : {} });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
};

test('a full request is 200 with the whole body and advertises byte ranges', async () => {
  const { res, body } = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(body, BODY);
});

test('bytes=0-9 is 206 with 10 bytes and a Content-Range', async () => {
  const { res, body } = await get('bytes=0-9');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(res.headers.get('content-length'), '10');
  assert.deepEqual(body, BODY.subarray(0, 10));
});

test('bytes=-5 is the last 5 bytes', async () => {
  const { res, body } = await get('bytes=-5');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 95-99/100');
  assert.deepEqual(body, BODY.subarray(95));
});

test('bytes=90- runs to the end, and an end past the file is clamped', async () => {
  const open = await get('bytes=90-');
  assert.equal(open.res.status, 206);
  assert.equal(open.res.headers.get('content-range'), 'bytes 90-99/100');
  assert.deepEqual(open.body, BODY.subarray(90));
  const clamped = await get('bytes=95-500');
  assert.equal(clamped.res.headers.get('content-range'), 'bytes 95-99/100');
});

test('an unsatisfiable range (start > end, or start at or past the size) is 416', async () => {
  for (const range of ['bytes=50-10', 'bytes=100-', 'bytes=500-600']) {
    const { res } = await get(range);
    assert.equal(res.status, 416, range);
    assert.equal(res.headers.get('content-range'), 'bytes */100', range);
  }
});

test('a multi-range or malformed header is ignored: 200 with the full body', async () => {
  for (const range of ['bytes=0-1,5-6', 'bytes=-', 'items=0-9', 'bytes=a-b']) {
    const { res, body } = await get(range);
    assert.equal(res.status, 200, range);
    assert.deepEqual(body, BODY, range);
  }
});
