import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { publicLookup } from '../yandex-poc/https.mjs';
import { downloadPublicDriveVideo } from './public-download.mjs';

const link = 'https://drive.google.com/uc?export=download&id=Example_123';
const cdn = 'https://drive.usercontent.google.com/download?id=Example_123&export=download';
const payload = Buffer.from('synthetic mp4 bytes');
const video = {
  format: { format_name: 'mov,mp4,m4a', duration: '300.25', tags: { major_brand: 'isom' } },
  streams: [{ codec_type: 'audio' }, { codec_type: 'video' }],
};

function media(body = payload, headers = {}) {
  return new Response(body, { headers: { 'content-type': 'video/mp4', ...headers } });
}

function fixture() {
  const urls = [];
  const inspected = [];
  const run = (responses, options = {}) => downloadPublicDriveVideo({
    link,
    request: async (url, opts) => {
      assert.equal(opts.redirect, 'manual');
      assert.ok(opts.signal);
      assert.equal(opts.headers, undefined);
      urls.push(url.href);
      assert.ok(responses.length, 'unexpected request');
      return responses.shift();
    },
    inspect: async file => {
      inspected.push(file);
      assert.deepEqual(await readFile(file), payload);
      return video;
    },
    ...options,
  });
  return { urls, inspected, run };
}

test('downloads MP4 directly with no credentials, verifies SHA-256 and removes temporary file and directory', async () => {
  const f = fixture();
  const result = await f.run([media(payload, { 'content-length': String(payload.length) })]);
  assert.deepEqual(f.urls, [link]);
  assert.equal(result.name, 'Импорт Google Drive.mp4');
  assert.equal(result.bytes, payload.length);
  assert.equal(result.durationSeconds, 300.25);
  assert.equal(result.sha256, createHash('sha256').update(payload).digest('hex'));
  assert.deepEqual(result.trace, [{ host: 'drive.google.com', status: 200 }]);
  await assert.rejects(access(f.inspected[0]), { code: 'ENOENT' });
  await assert.rejects(access(path.dirname(f.inspected[0])), { code: 'ENOENT' });
});

test('follows the exact Google download host and preserves a resource key', async () => {
  const f = fixture();
  const full = link + '&resourcekey=0-Synthetic';
  const result = await f.run([Response.redirect(cdn), media(payload, {
    'content-type': 'application/octet-stream',
  })], { link: full });
  assert.deepEqual(f.urls, [full, cdn]);
  assert.deepEqual(result.trace, [
    { host: 'drive.google.com', status: 302 },
    { host: 'drive.usercontent.google.com', status: 200 },
  ]);
});

test('keeps a verified MP4 in a server-owned directory and converts a public view URL', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'meeting-drive-server-test-'));
  const file = path.join(directory, 'source.mp4');
  t.after(async () => {
    await rm(file, { force: true });
    await rmdir(directory);
  });
  const f = fixture();
  const result = await f.run([media()], {
    directory,
    link: 'https://drive.google.com/file/d/Example_123/view?usp=sharing&resourcekey=0-Synthetic',
  });
  assert.deepEqual(f.urls, [link + '&resourcekey=0-Synthetic']);
  assert.equal(result.file, file);
  assert.deepEqual(await readFile(file), payload);
  await assert.rejects(f.run([media()], { directory }), { code: 'TRANSFER_FAILED' });
  assert.deepEqual(await readFile(file), payload);
  await rm(file);
  await assert.rejects(f.run([media(payload, { 'content-length': String(payload.length + 1) })], {
    directory,
  }), { code: 'SIZE_MISMATCH' });
  await assert.rejects(access(file), { code: 'ENOENT' });
  await access(directory);
});

test('uses a safe fallback for untrusted and ambiguous download filenames', async () => {
  for (const disposition of [
    'attachment; filename="../../secret.mp4"',
    "attachment; filename*=UTF-8''%5Csecret.mp4",
    "attachment; filename*=UTF-8''%E2%80%AEsecret.mp4",
    "attachment; filename*=UTF-8''%ff.mp4",
    'attachment; filename="other.webm"',
    'attachment; filename="one.mp4"; filename="two.mp4"',
    'attachment; note="; filename=hidden.mp4"',
  ]) {
    const result = await fixture().run([media(payload, { 'content-disposition': disposition })]);
    assert.equal(result.name, 'Импорт Google Drive.mp4');
  }
});

test('recognizes WebM by its container even with generic content type', async () => {
  const header = Buffer.from('1a45dfa3874282847765626d', 'hex');
  const result = await fixture().run([media(header, { 'content-type': 'application/octet-stream' })], {
    inspect: async () => ({ ...video, format: { format_name: 'matroska,webm', duration: '300.25' } }),
  });
  assert.equal(result.name, 'Импорт Google Drive.webm');
  assert.equal(result.sha256, createHash('sha256').update(header).digest('hex'));
});

test('rejects unsafe or ambiguous input URLs before opening a connection', async () => {
  const f = fixture();
  for (const candidate of [
    link.replace('https:', 'http:'), link.replace('drive.google.com', 'drive.google.com.example.test'),
    link.replace('drive.google.com', 'drive.google.com@127.0.0.1'),
    link + '&id=Other', link + '&resourcekey=', link + '&resourcekey=a&resourcekey=b',
    link.replace('Example_123', 'x%2Fy'), link + '&redirect=https://127.0.0.1/', link + '#fragment',
  ]) {
    await assert.rejects(f.run([], { link: candidate }), { code: 'INVALID_LINK' });
  }
  assert.deepEqual(f.urls, []);
});

test('rejects unapproved redirect hosts, paths, ports and credentials', async () => {
  for (const location of [
    'http://drive.usercontent.google.com/download',
    'https://drive.usercontent.google.com.example.test/download',
    'https://sub.drive.usercontent.google.com/download',
    'https://accounts.google.com/download',
    'https://drive.usercontent.google.com:444/download',
    'https://user@drive.usercontent.google.com/download',
    'https://drive.usercontent.google.com/other',
    'https://127.0.0.1/download',
    'https://[::1]/download',
    'https://169.254.169.254/download',
  ]) {
    const f = fixture();
    await assert.rejects(f.run([Response.redirect(location)]), { code: 'UNSAFE_REDIRECT' });
    assert.deepEqual(f.urls, [link]);
  }
});

test('checks a redirect from the final download host and caps redirect chains', async () => {
  const f = fixture();
  await assert.rejects(f.run([Response.redirect(cdn), Response.redirect('https://127.0.0.1/download')]),
    { code: 'UNSAFE_REDIRECT' });
  assert.deepEqual(f.urls, [link, cdn]);
  const g = fixture();
  await assert.rejects(g.run(Array.from({ length: 4 }, () => Response.redirect(cdn))), { code: 'REDIRECT_LIMIT' });
  assert.equal(g.urls.length, 4);
});

test('shared DNS lookup rejects a private IP for an allowed Google host', async () => {
  const hostname = 'drive.usercontent.google.com';
  const lookup = address => new Promise((accept, reject) => {
    publicLookup(hostname, {}, (error, ip, family) => {
      if (error) reject(error);
      else accept({ ip, family });
    }, (host, options, callback) => {
      assert.equal(host, hostname);
      assert.deepEqual(options, { all: true, family: 4 });
      callback(null, [{ address, family: 4 }]);
    });
  });
  await assert.rejects(lookup('192.168.1.2'), { code: 'UNSAFE_DNS' });
  assert.deepEqual(await lookup('8.8.8.8'), { ip: '8.8.8.8', family: 4 });
  const f = fixture();
  await assert.rejects(f.run([], {
    request: async () => { throw Object.assign(new Error('Unsafe'), { code: 'UNSAFE_DNS' }); },
  }), { code: 'UNSAFE_DNS' });
});

test('rejects HTML, unavailable files, quota errors and partial HTTP responses without retry', async () => {
  const cases = [
    [media('<html>confirmation page</html>', { 'content-type': 'text/html; charset=UTF-8' }), 'UNEXPECTED_CONTENT'],
    [new Response(null, { status: 403 }), 'UNAVAILABLE'],
    [new Response(null, { status: 429 }), 'QUOTA'],
    [new Response(payload, { status: 206 }), 'UNEXPECTED_RESPONSE'],
  ];
  for (const [response, code] of cases) {
    const f = fixture();
    await assert.rejects(f.run([response]), { code });
    assert.deepEqual(f.urls, [link]);
    assert.deepEqual(f.inspected, []);
  }
});

test('rejects declared oversize and inconsistent Content-Length values', async () => {
  const f = fixture();
  await assert.rejects(f.run([media(payload, { 'content-length': '50000001' })]), { code: 'TOO_LARGE' });
  await assert.rejects(f.run([media(payload, { 'content-length': '0' })]), { code: 'INVALID_LENGTH' });
  await assert.rejects(f.run([media(payload, { 'content-length': String(payload.length + 1) })]), { code: 'SIZE_MISMATCH' });
  await assert.rejects(f.run([media(payload, { 'content-length': String(payload.length - 1) })]), { code: 'SIZE_MISMATCH' });
  assert.deepEqual(f.inspected, []);
});

function sizeStream(bytes) {
  const chunk = Buffer.alloc(100_000);
  return new ReadableStream({
    pull(controller) {
      if (!bytes) return controller.close();
      const length = Math.min(bytes, chunk.length);
      controller.enqueue(chunk.subarray(0, length));
      bytes -= length;
    },
  });
}

test('enforces 50,000,000 bytes on the stream without Content-Length', async () => {
  const f = fixture();
  const result = await f.run([media(sizeStream(50_000_000))], { inspect: async () => video });
  assert.equal(result.bytes, 50_000_000);
  await assert.rejects(f.run([media(sizeStream(50_000_001))]), { code: 'TOO_LARGE' });
  assert.deepEqual(f.inspected, []);
});

test('rejects disguised HTML, missing tracks and excessive duration and removes the file', async () => {
  const cases = [
    async () => { throw new Error('Not a media file'); },
    async () => ({ ...video, streams: [{ codec_type: 'audio' }] }),
    async () => ({ ...video, streams: [{ codec_type: 'video' }] }),
    async () => ({ ...video, format: { ...video.format, duration: '300.26' } }),
  ];
  for (const inspect of cases) {
    let file;
    await assert.rejects(fixture().run([media('<html>', { 'content-type': 'application/octet-stream' })], {
      inspect: async candidate => { file = candidate; return inspect(); },
    }), { code: 'INVALID_VIDEO' });
    await assert.rejects(access(file), { code: 'ENOENT' });
  }
});

test('aborts a stalled response and a stalled body', async () => {
  const f = fixture();
  await assert.rejects(f.run([], {
    timeoutMs: 25,
    request: async (url, { signal }) => delay(1000, null, { signal }),
  }), { code: 'TIMEOUT' });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 1)); } });
    await assert.rejects(f.run([media(stream)], { timeoutMs: 50 }), { code: 'TIMEOUT' });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(f.inspected, []);
});
