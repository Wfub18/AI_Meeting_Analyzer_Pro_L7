import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { downloadDriveMp4, parseDriveLink } from './import.mjs';

const id = 'FakeFile_123';
const key = '0-FakeResource_Key';
const link = 'https://drive.google.com/file/d/' + id + '/view';
const payload = Buffer.from('synthetic media bytes');
const sha256 = createHash('sha256').update(payload).digest('hex');
const endpoint = 'https://www.googleapis.com/drive/v3/files/' + id;

function metadata(overrides = {}) {
  return Response.json({ id, name: '../untrusted.mp4', mimeType: 'video/mp4',
    size: String(payload.length), capabilities: { canDownload: true }, ...overrides });
}

function media(bytes = payload, headers = {}) {
  return new Response(bytes, { headers: { 'content-type': 'video/mp4', ...headers } });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meeting-drive-test-'));
  t.after(async () => {
    await unlink(path.join(directory, 'source.mp4')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  });
  const calls = [];
  const run = (responses, overrides = {}) => downloadDriveMp4({
    link, apiKey: 'fake_google_key', directory,
    request: async (url, options) => {
      calls.push({ url: new URL(url), ...options });
      const response = responses.shift();
      assert.ok(response, 'unexpected HTTP request');
      return response;
    },
    ...overrides,
  });
  return { directory, calls, run };
}

test('accepts a Drive file share URL and decodes one resource key', () => {
  assert.deepEqual(parseDriveLink(link), { fileId: id, resourceKey: undefined });
  assert.deepEqual(parseDriveLink(link + '?usp=sharing&resourcekey=0%2DFakeResource_Key'), {
    fileId: id, resourceKey: key,
  });
  assert.equal(parseDriveLink(link.replace('/view', '/preview')).fileId, id);
});

test('rejects untrusted hosts and ambiguous URLs before any request', async t => {
  const f = await fixture(t);
  for (const candidate of [
    'http://drive.google.com/file/d/id/view',
    'https://drive.google.com.evil.example/file/d/id/view',
    'https://drive.google.com@127.0.0.1/file/d/id/view',
    'https://127.0.0.1/file/d/id/view',
    'https://[::1]/file/d/id/view',
    'https://drive.google.com:443/file/d/id/view',
    'https://drive.google.com/drive/folders/id',
    'https://drive.google.com/file/d/%2f..%2f/view',
    'https://drive.google.com/file/d/id/../id/view',
  ]) {
    await assert.rejects(f.run([], { link: candidate }), { code: 'INVALID_LINK' });
  }
  assert.equal(f.calls.length, 0);
});

test('rejects empty, repeated and unsafe resource keys before any request', async t => {
  const f = await fixture(t);
  for (const query of ['resourcekey=', 'resourcekey=a&resourcekey=b', 'resourcekey=a%0D%0Ab', 'resourcekey=a%2Fb']) {
    await assert.rejects(f.run([], { link: link + '?' + query }), { code: 'INVALID_RESOURCE_KEY' });
  }
  assert.equal(f.calls.length, 0);
});

test('requires an API key before any request', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([], { apiKey: '' }), { code: 'MISSING_API_KEY' });
  assert.equal(f.calls.length, 0);
});

test('downloads bytes from the fixed API with resource key and no OAuth, and verifies SHA-256', async t => {
  const f = await fixture(t);
  const result = await f.run([metadata({ sha256Checksum: sha256.toUpperCase() }), media(payload, {
    'content-length': String(payload.length),
  })], { link: link + '?resourcekey=' + key + '&next=https://127.0.0.1/' });
  assert.deepEqual(f.calls.map(call => call.url.origin + call.url.pathname), [endpoint, endpoint]);
  for (const call of f.calls) {
    assert.deepEqual(call.headers, { 'x-goog-api-key': 'fake_google_key', 'x-goog-drive-resource-keys': id + '/' + key });
    assert.equal(call.redirect, 'manual');
    assert.equal(call.url.searchParams.has('key'), false);
  }
  assert.match(f.calls[0].url.searchParams.get('fields'), /capabilities\(canDownload\)/);
  assert.equal(f.calls[1].url.search, '?alt=media');
  assert.deepEqual(result, { file: path.join(f.directory, 'source.mp4'), fileId: id,
    name: '../untrusted.mp4', bytes: payload.length, sha256, verifiedChecksum: 'sha256' });
  assert.deepEqual(await readFile(result.file), payload);
});

test('works without resource key, Content-Length or provider checksum', async t => {
  const f = await fixture(t);
  const result = await f.run([metadata(), media()]);
  assert.equal(result.verifiedChecksum, null);
  assert.equal(result.sha256, sha256);
  assert.equal(Object.hasOwn(f.calls[0].headers, 'x-goog-drive-resource-keys'), false);
});

test('verifies MD5 when Drive only provides MD5', async t => {
  const f = await fixture(t);
  const result = await f.run([metadata({ md5Checksum: createHash('md5').update(payload).digest('hex') }), media()]);
  assert.equal(result.verifiedChecksum, 'md5');
  assert.equal(result.sha256, sha256);
});

test('refuses wrong ID, wrong MIME, denied downloads and invalid or oversized metadata before downloading', async t => {
  const f = await fixture(t);
  const cases = [
    [{ id: 'wrong' }, 'INVALID_METADATA'],
    [{ mimeType: 'application/vnd.google-apps.shortcut' }, 'UNSUPPORTED_TYPE'],
    [{ capabilities: { canDownload: false } }, 'DOWNLOAD_FORBIDDEN'],
    [{ size: undefined }, 'INVALID_SIZE'],
    [{ size: '0' }, 'INVALID_SIZE'],
    [{ size: '50000001' }, 'FILE_TOO_LARGE'],
    [{ sha256Checksum: 'invalid' }, 'INVALID_CHECKSUM'],
  ];
  for (const [patch, code] of cases) {
    await assert.rejects(f.run([metadata(patch)]), { code });
  }
  assert.equal(f.calls.length, cases.length);
  assert.deepEqual(await readdir(f.directory), []);
});

test('writes a streamed file at the exact 50,000,000 byte limit', async t => {
  const f = await fixture(t);
  const chunk = Buffer.alloc(100_000);
  let remaining = 500;
  const stream = new ReadableStream({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const result = await f.run([metadata({ size: '50000000' }), media(stream)]);
  assert.equal(result.bytes, 50_000_000);
  assert.equal((await stat(result.file)).size, result.bytes);
});

test('returns safe messages for restricted files, quota and bad API setup', async t => {
  const f = await fixture(t);
  const cases = [
    [new Response(null, { status: 404 }), 'FILE_UNAVAILABLE'],
    [Response.json({ error: { message: 'secret-upstream-body' } }, { status: 403 }), 'FILE_UNAVAILABLE'],
    [Response.json({ error: { errors: [{ reason: 'downloadQuotaExceeded' }] } }, { status: 403 }), 'DRIVE_QUOTA'],
    [new Response(null, { status: 429 }), 'DRIVE_QUOTA'],
    [Response.json({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 }), 'DRIVE_CONFIGURATION'],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(f.run([response]), error => error.code === code &&
      !error.message.includes('secret-upstream-body'));
  }
});

test('does not follow redirects from metadata or media, including a local destination', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([Response.redirect('http://169.254.169.254/latest/meta-data/')]),
    { code: 'UNEXPECTED_REDIRECT' });
  await assert.rejects(f.run([metadata(), Response.redirect('https://evil.example/')]),
    { code: 'UNEXPECTED_REDIRECT' });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.url.hostname === 'www.googleapis.com'));
});

test('rejects HTML, partial HTTP responses and mismatched Content-Length', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([metadata(), media('<html>', { 'content-type': 'text/html' })]),
    { code: 'UNEXPECTED_CONTENT' });
  await assert.rejects(f.run([metadata(), new Response(payload, { status: 206 })]), { code: 'DRIVE_RESPONSE' });
  await assert.rejects(f.run([metadata(), media(payload, { 'content-length': '1' })]), { code: 'SIZE_MISMATCH' });
  assert.deepEqual(await readdir(f.directory), []);
});

test('cleans up files after a short body, oversized stream or checksum mismatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([metadata(), media(payload.subarray(1))]), { code: 'SIZE_MISMATCH' });
  assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(f.run([metadata(), media(Buffer.concat([payload, payload]))]), { code: 'SIZE_MISMATCH' });
  assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(f.run([metadata({ sha256Checksum: 'a'.repeat(64) }), media()]), { code: 'CHECKSUM_MISMATCH' });
  assert.deepEqual(await readdir(f.directory), []);
});

test('times out HTTP and cleans up when the download body stops', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([], { timeoutMs: 20, request: async (url, { signal }) => {
    await delay(1000, null, { signal });
  } }), { code: 'TIMEOUT' });

  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const body = new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 1)); } });
    await assert.rejects(f.run([metadata(), media(body)], { timeoutMs: 40 }), { code: 'TIMEOUT' });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(await readdir(f.directory), []);
});

test('never overwrites or removes an existing destination', async t => {
  const f = await fixture(t);
  const existing = path.join(f.directory, 'source.mp4');
  await writeFile(existing, 'keep');
  await assert.rejects(f.run([metadata(), media()]), { code: 'DESTINATION_EXISTS' });
  assert.equal(await readFile(existing, 'utf8'), 'keep');
});
