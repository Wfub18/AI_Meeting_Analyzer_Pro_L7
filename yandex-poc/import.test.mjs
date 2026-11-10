import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { downloadYandexVideo } from './import.mjs';
import { publicLookup } from './https.mjs';

const link = 'https://disk.yandex.ru/d/PublicFile';
const endpoint = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const href = 'https://downloader.disk.yandex.ru/disk/signed-token?size=10';
const mp4 = Buffer.from('sample mp4 bytes');
const webm = Buffer.from('1a45dfa3874282847765626d', 'hex');
const mkv = Buffer.from('1a45dfa38b4282886d6174726f736b61', 'hex');
const tracks = [{ codec_type: 'audio' }, { codec_type: 'video' }];
const mp4Probe = { format: { format_name: 'mov,mp4,m4a', duration: '120', tags: { major_brand: 'isom' } }, streams: tracks };
const webmProbe = { format: { format_name: 'matroska,webm', duration: '120' }, streams: tracks };

function meta(overrides = {}) {
  return Response.json({ name: '../sample.MP4', size: mp4.length, type: 'file', mime_type: 'video/mp4', ...overrides });
}

function target(overrides = {}) {
  return Response.json({ href, method: 'GET', templated: false, ...overrides });
}

function media(bytes = mp4, headers = {}) {
  return new Response(bytes, { headers: { 'content-type': 'video/mp4', ...headers } });
}

function fixture() {
  const urls = [];
  const inspected = [];
  const run = (responses, options = {}) => downloadYandexVideo({
    link,
    request: async (url, { redirect, signal }) => {
      assert.equal(redirect, 'manual');
      assert.ok(signal);
      urls.push(new URL(url));
      assert.ok(responses.length, 'unexpected request');
      return responses.shift();
    },
    inspect: async file => {
      inspected.push(file);
      assert.deepEqual(await readFile(file), mp4);
      return mp4Probe;
    },
    ...options,
  });
  return { urls, inspected, run };
}

test('downloads MP4 through both public API methods and cleans up the temporary file', async () => {
  const f = fixture();
  const result = await f.run([meta(), target(), media(mp4, { 'content-length': String(mp4.length) })],
    { link: link + '?ignored=https://127.0.0.1/#ignored' });
  assert.deepEqual(f.urls.map(url => url.origin + url.pathname), [endpoint, endpoint + '/download', href.split('?')[0]]);
  assert.deepEqual(f.urls.slice(0, 2).map(url => [...url.searchParams]), [[['public_key', link]], [['public_key', link]]]);
  assert.deepEqual(result, { name: '../sample.MP4', bytes: mp4.length, durationSeconds: 120,
    sha256: createHash('sha256').update(mp4).digest('hex') });
  assert.match(f.inspected[0], /source\.mp4$/);
  await assert.rejects(access(f.inspected[0]), { code: 'ENOENT' });
});

test('accepts WebM with its EBML DocType and an approved download redirect', async () => {
  const f = fixture();
  const destination = 'https://downloader.dst.yandex.ru/disk/next';
  const result = await f.run([
    meta({ name: 'sample.webm', size: webm.length, mime_type: 'video/webm' }), target(),
    Response.redirect(destination), media(webm, { 'content-type': 'application/octet-stream' }),
  ], {
    link: 'https://yadi.sk/i/LegacyFile',
    inspect: async file => {
      assert.deepEqual(await readFile(file), webm);
      return webmProbe;
    },
  });
  assert.equal(f.urls.at(-1).href, destination);
  assert.equal(result.bytes, webm.length);
});

test('follows the exact MDS redirect and cleans up the downloaded file', async () => {
  const f = fixture();
  const destination = 'https://mds.storage.yandex.net/rdisk/signed-token?fixture=1';
  const result = await f.run([meta(), target(), Response.redirect(destination), media()]);
  assert.deepEqual(f.urls.map(url => url.hostname), [
    'cloud-api.yandex.net', 'cloud-api.yandex.net', 'downloader.disk.yandex.ru', 'mds.storage.yandex.net',
  ]);
  assert.equal(f.urls.at(-1).href, destination);
  assert.equal(result.bytes, mp4.length);
  await assert.rejects(access(f.inspected[0]), { code: 'ENOENT' });
});

test('rejects unsafe MDS lookalikes, URLs and paths before issuing a request', async () => {
  const candidates = [
    'https://external.test/rdisk/t',
    'https://sub.mds.storage.yandex.net/rdisk/t',
    'https://mds.storage.yandex.net.external.test/rdisk/t',
    'https://mds.storage.yandex.net./rdisk/t',
    'https://other.storage.yandex.net/rdisk/t',
    'https://mds.storage.yandex.net@external.test/rdisk/t',
    'https://attacker@mds.storage.yandex.net/rdisk/t',
    'http://mds.storage.yandex.net/rdisk/t',
    'https://mds.storage.yandex.net:444/rdisk/t',
    'https://mds.storage.yandex.net/rdisk/t#fragment',
    'https://mds.storage.yandex.net/admin/t',
    'https://mds.storage.yandex.net/rdisk/../admin',
    'https://169.254.169.254/rdisk/t',
  ];
  for (const location of candidates) {
    const f = fixture();
    await assert.rejects(f.run([meta(), target(), Response.redirect(location)]), { code: 'UNSAFE_URL' });
    assert.equal(f.urls.length, 3, location);
    assert.equal(f.urls.at(-1).hostname, 'downloader.disk.yandex.ru');
  }
});

test('rejects untrusted public URLs before any request', async () => {
  const f = fixture();
  for (const candidate of [
    'http://disk.yandex.ru/d/id', 'https://disk.yandex.ru.evil.test/d/id',
    'https://disk.yandex.ru@127.0.0.1/d/id', 'https://127.0.0.1/d/id',
    'https://disk.yandex.ru:444/d/id', 'https://disk.yandex.ru/d/%2e%2e',
    'https://disk.yandex.ru/d/id/another-file',
  ]) {
    await assert.rejects(f.run([], { link: candidate }), { code: 'INVALID_LINK' });
  }
  assert.equal(f.urls.length, 0);
});

test('rejects external, private, deceptive and non-HTTPS download targets', async () => {
  const f = fixture();
  const candidates = [
    'http://downloader.disk.yandex.ru/disk/t', 'https://127.0.0.1/disk/t',
    'https://[::1]/disk/t', 'https://169.254.169.254/disk/t',
    'https://downloader.disk.yandex.ru.evil.test/disk/t',
    'https://downloader.disk.yandex.ru@evil.test/disk/t',
    'https://attacker@downloader.disk.yandex.ru/disk/t',
    'https://downloader.disk.yandex.ru:444/disk/t',
    'https://downloader.disk.yandex.ru/admin', '/disk/not-absolute',
  ];
  for (const candidate of candidates) {
    await assert.rejects(f.run([meta(), target({ href: candidate })]), { code: 'UNSAFE_URL' });
  }
  assert.equal(f.urls.length, candidates.length * 2);
  assert.ok(f.urls.every(url => url.hostname === 'cloud-api.yandex.net'));
});

test('blocks unsafe redirects, API redirects and excessive redirect chains', async () => {
  const f = fixture();
  await assert.rejects(f.run([meta(), target(), Response.redirect('https://127.0.0.1/disk/t')]), { code: 'UNSAFE_URL' });
  assert.equal(f.urls.length, 3);
  await assert.rejects(f.run([Response.redirect(href)]), { code: 'UNEXPECTED_RESPONSE' });
  assert.equal(f.urls.length, 4);
  await assert.rejects(f.run([meta(), target(), new Response(null, { status: 302 })]), { code: 'INVALID_REDIRECT' });
  await assert.rejects(f.run([meta(), target(), ...Array.from({ length: 4 }, () => Response.redirect(href))]),
    { code: 'INVALID_REDIRECT' });
});

test('DNS rejects non-public answers and passes a checked IPv4 directly', async () => {
  const resolve = addresses => (hostname, options, callback) => {
    assert.equal(hostname, 'downloader.disk.yandex.ru');
    assert.deepEqual(options, { all: true, family: 4 });
    callback(null, addresses.map(address => ({ address, family: 4 })));
  };
  const lookup = addresses => new Promise((accept, reject) => {
    publicLookup('downloader.disk.yandex.ru', {}, (error, address, family) => {
      if (error) reject(error);
      else accept({ address, family });
    }, resolve(addresses));
  });
  for (const address of ['127.0.0.1', '10.2.3.4', '100.64.0.1', '169.254.169.254',
    '172.31.0.1', '192.168.0.1', '192.0.2.1', '::1', '::ffff:127.0.0.1']) {
    await assert.rejects(lookup(['8.8.8.8', address]), { code: 'UNSAFE_DNS' });
  }
  await assert.rejects(lookup([]), { code: 'UNSAFE_DNS' });
  assert.deepEqual(await lookup(['8.8.8.8']), { address: '8.8.8.8', family: 4 });
});

test('returns access and quota errors at metadata, link and media stages', async () => {
  const f = fixture();
  await assert.rejects(f.run([new Response(null, { status: 404 })]), { code: 'UNAVAILABLE' });
  await assert.rejects(f.run([meta(), new Response(null, { status: 403 })]), { code: 'UNAVAILABLE' });
  await assert.rejects(f.run([meta(), target(), new Response(null, { status: 410 })]), { code: 'UNAVAILABLE' });
  await assert.rejects(f.run([new Response(null, { status: 429 })]), { code: 'QUOTA' });
});

test('rejects bad JSON, excessive JSON and invalid download objects', async () => {
  const f = fixture();
  for (const body of ['{bad JSON', ' '.repeat(65_537)]) {
    await assert.rejects(f.run([new Response(body, { headers: { 'content-type': 'application/json' } })]),
      { code: 'INVALID_JSON' });
  }
  await assert.rejects(f.run([new Response('<html>')]), { code: 'INVALID_JSON' });
  for (const fields of [{ href: null }, { method: 'POST' }, { templated: true }]) {
    await assert.rejects(f.run([meta(), target(fields)]), { code: 'INVALID_DOWNLOAD_LINK' });
  }
});

test('rejects folders, unsupported formats and invalid or oversized metadata before requesting href', async () => {
  const f = fixture();
  const cases = [
    [{ type: 'dir' }, 'FOLDER'], [{ name: '' }, 'INVALID_METADATA'], [{ size: '20' }, 'INVALID_METADATA'],
    [{ size: 0 }, 'INVALID_METADATA'], [{ name: 'file.avi' }, 'UNSUPPORTED_FORMAT'],
    [{ mime_type: 'text/html' }, 'UNSUPPORTED_FORMAT'], [{ size: 50_000_001 }, 'TOO_LARGE'],
  ];
  for (const [fields, code] of cases) {
    await assert.rejects(f.run([meta(fields)]), { code });
  }
  assert.equal(f.urls.length, cases.length);
});

test('streams exactly 50,000,000 bytes without buffering the whole download', async () => {
  const f = fixture();
  const chunk = Buffer.alloc(100_000);
  let remaining = 500;
  const body = new ReadableStream({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const result = await f.run([meta({ size: 50_000_000 }), target(), media(body)], { inspect: async () => mp4Probe });
  assert.equal(result.bytes, 50_000_000);
});

test('rejects HTML, partial HTTP, incorrect declared length and mismatched body length', async () => {
  const f = fixture();
  await assert.rejects(f.run([meta(), target(), media('<html>', { 'content-type': 'text/html' })]), { code: 'INVALID_MEDIA_RESPONSE' });
  await assert.rejects(f.run([meta(), target(), new Response(mp4, { status: 206 })]), { code: 'UNEXPECTED_RESPONSE' });
  await assert.rejects(f.run([meta(), target(), media(mp4, { 'content-length': '1' })]), { code: 'SIZE_MISMATCH' });
  for (const body of [mp4.subarray(1), Buffer.concat([mp4, mp4])]) {
    await assert.rejects(f.run([meta(), target(), media(body)]), { code: 'SIZE_MISMATCH' });
  }
  assert.equal(f.inspected.length, 0);
});

test('rejects wrong containers, missing tracks and duration above 300 seconds', async () => {
  const f = fixture();
  const cases = [
    [{ ...mp4Probe, format: { ...mp4Probe.format, tags: { major_brand: 'qt' } } }, 'INVALID_VIDEO'],
    [{ ...mp4Probe, streams: [{ codec_type: 'video' }] }, 'MISSING_TRACK'],
    [{ ...mp4Probe, streams: [{ codec_type: 'audio' }] }, 'MISSING_TRACK'],
    [{ ...mp4Probe, format: { ...mp4Probe.format, duration: '300.01' } }, 'INVALID_DURATION'],
  ];
  for (const [probe, code] of cases) {
    let temp;
    await assert.rejects(f.run([meta(), target(), media()], {
      inspect: async file => { temp = file; return probe; },
    }), { code });
    await assert.rejects(access(temp), { code: 'ENOENT' });
  }
  await assert.rejects(f.run([
    meta({ name: 'renamed.webm', size: mkv.length, mime_type: 'video/webm' }), target(),
    media(mkv, { 'content-type': 'video/webm' }),
  ], { inspect: async () => webmProbe }), { code: 'INVALID_VIDEO' });
});

test('times out the request and a stalled media stream', async () => {
  const f = fixture();
  await assert.rejects(f.run([], { timeoutMs: 25, request: async (url, { signal }) => delay(1000, null, { signal }) }),
    { code: 'TIMEOUT' });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const body = new ReadableStream({ start(controller) { controller.enqueue(mp4.subarray(0, 1)); } });
    await assert.rejects(f.run([meta(), target(), media(body)], { timeoutMs: 50 }), { code: 'TIMEOUT' });
  } finally {
    clearTimeout(keepAlive);
  }
});
