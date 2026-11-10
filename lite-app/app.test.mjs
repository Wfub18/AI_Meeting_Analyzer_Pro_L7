import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createContext, runInContext } from 'node:vm';
import { binaries, run, probe } from '../poc/media.mjs';
import { openAI } from './meeting.mjs';
import { start } from './server.mjs';

const speech = 'Запуск согласован. Надо проверить отчёт.';
const notes = {
  summary: [{ text: 'Обсудили запуск.', evidence: 'Запуск согласован.' }],
  decisions: [{ text: 'Запуск согласован.', evidence: 'Запуск согласован.' }],
  tasks: [{ text: 'Проверить отчёт.', evidence: 'Надо проверить отчёт.' }],
  questions: [],
};
let fixtures;

async function video(name, codec, sound = true, seconds = 1) {
  const file = path.join(fixtures, name);
  await run(binaries().ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=s=160x90:r=1',
    ...(sound ? ['-f', 'lavfi', '-i', 'sine=frequency=440', '-c:a', codec] : ['-an']),
    '-t', String(seconds), '-c:v', name.endsWith('.mp4') ? 'libx264' : 'libvpx-vp9', '-threads', '1', file]);
  return readFile(file);
}

let mp4, webm, alac, noAudio, mkv, tooLong;
before(async () => {
  fixtures = await mkdtemp(path.join(tmpdir(), 'meeting-lite-fixtures-'));
  mp4 = await video('aac.mp4', 'aac', true, 120);
  webm = await video('opus.webm', 'libopus', true, 120);
  alac = await video('alac.mp4', 'alac');
  noAudio = await video('no-audio.mp4', null, false);
  mkv = await video('mkv.mkv', 'libopus');
  tooLong = await video('too-long.mp4', 'aac', true, 301);
});
async function removeTestDirectory(directory) {
  const target = await realpath(directory);
  const parent = await realpath(tmpdir());
  assert.equal(path.dirname(target), parent);
  assert.match(path.basename(target), /^meeting-lite-(data|fixtures)-[a-zA-Z0-9]+$/);
  await rm(target, { recursive: true, force: true });
}
after(async () => {
  if (fixtures) await removeTestDirectory(fixtures);
});

async function app(t, ai, existingDir, driveRequest) {
  const dataDir = existingDir ?? await mkdtemp(path.join(tmpdir(), 'meeting-lite-data-'));
  let server;
  const stop = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  t.after(async () => {
    if (server?.listening) await stop();
    if (!existingDir) await removeTestDirectory(dataDir);
  });
  server = await start({ dataDir, port: 0, ai, driveRequest });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { stop, dataDir, origin, get: endpoint => fetch(origin + endpoint),
    remove: (id, headers) => fetch(origin + '/api/meetings/' + id, { method: 'DELETE', headers }),
    importDrive: url => fetch(origin + '/api/imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    }),
    upload: (name, body, headers) =>
    fetch(origin + '/api/meetings', {
      method: 'POST', headers: { 'x-file-name': encodeURIComponent(name), ...headers }, body,
    }) };
}

async function submit(app, name, content) {
  const response = await app.upload(name, content);
  assert.equal(response.status, 202, await response.clone().text());
  return (await response.json()).id;
}

async function status(app, id) {
  return (await app.get('/api/meetings/' + id)).json();
}

async function done(app, id) {
  for (let i = 0; i < 150; i++) {
    const record = await status(app, id);
    if (record.status !== 'processing') return record;
    await wait(50);
  }
  throw new Error('Meeting did not finish');
}

const driveLink = 'https://drive.google.com/file/d/Synthetic_ID/view?usp=sharing';

function fakeDrive(bytes, headers = {}) {
  return async (url, { redirect }) => {
    assert.equal(url.href, 'https://drive.google.com/uc?export=download&id=Synthetic_ID');
    assert.equal(redirect, 'manual');
    return new Response(bytes, { headers: { 'content-type': 'video/mp4', ...headers } });
  };
}

test('deduplicates uploads and Drive imports in both directions and after restart', async t => {
  let paid = 0;
  const ai = {
    async transcribe(audio) {
      paid++;
      const directory = path.dirname(audio);
      const record = JSON.parse(await readFile(path.join(directory, '..', '..', path.basename(directory) + '.json'), 'utf8'));
      assert.equal(record.status, 'processing');
      assert.equal(record.phase, 'transcription');
      assert.equal(record.aiStarted, true);
      assert.match(record.sha256, /^[a-f0-9]{64}$/);
      assert.ok((await readdir(directory)).includes('source.mp4'));
      return speech;
    },
    summarize: async () => notes,
  };
  let bytes = mp4;
  const driveRequest = (...args) => fakeDrive(bytes, {
    'content-disposition': 'attachment; filename="Original meeting.mp4"',
  })(...args);
  const server = await app(t, ai, undefined, driveRequest);
  const uploadId = await submit(server, 'upload.mp4', mp4);
  const upload = await done(server, uploadId);
  assert.equal(upload.status, 'ready');
  assert.equal(upload.source, 'upload');
  assert.equal(upload.sha256, createHash('sha256').update(mp4).digest('hex'));

  const duplicate = await server.importDrive(driveLink);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { id: uploadId, duplicate: true });
  assert.equal(paid, 1);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);

  bytes = alac;
  const imported = await server.importDrive(driveLink);
  assert.equal(imported.status, 202);
  const { id } = await imported.json();
  const ready = await done(server, id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.source, 'google-drive');
  assert.equal(ready.name, 'Original meeting.mp4');
  assert.equal(ready.sha256, createHash('sha256').update(alac).digest('hex'));
  assert.equal(ready.transcript, speech);
  assert.deepEqual(ready.notes, notes);
  assert.equal(await submit(server, 'same.mp4', alac), id);
  assert.equal(paid, 2);

  await server.stop();
  const restarted = await app(t, ai, server.dataDir, driveRequest);
  const again = await restarted.importDrive(driveLink);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { id, duplicate: true });
  assert.deepEqual(await status(restarted, id), ready);
  assert.deepEqual((await (await restarted.get('/api/meetings')).json()).map(record => record.id), [id, uploadId]);
  assert.equal((await readdir(server.dataDir)).filter(name => name.endsWith('.json')).length, 2);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);
  assert.equal(paid, 2);
  await restarted.stop();
});

test('imports genuine WebM and rejects Matroska served as WebM before analysis', async t => {
  let calls = 0;
  let bytes = mkv;
  const ai = {
    transcribe: async audio => {
      calls++;
      assert.equal(path.extname(audio), '.webm');
      assert.ok((await readdir(path.dirname(audio))).includes('source.webm'));
      return speech;
    },
    summarize: async () => notes,
  };
  const server = await app(t, ai, undefined, (...args) => fakeDrive(bytes, {
    'content-type': 'video/webm',
    'content-disposition': "attachment; filename*=UTF-8''%D0%A2%D0%B5%D1%81%D1%82.webm",
  })(...args));
  const rejected = await server.importDrive(driveLink);
  assert.equal(rejected.status, 422);
  assert.match((await rejected.json()).error, /Содержимое файла/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);

  bytes = webm;
  const accepted = await server.importDrive(driveLink);
  assert.equal(accepted.status, 202);
  const { id } = await accepted.json();
  const record = await done(server, id);
  assert.equal(record.status, 'ready');
  assert.equal(record.name, 'Тест.webm');
  assert.equal(record.source, 'google-drive');
  assert.equal(record.sha256, createHash('sha256').update(webm).digest('hex'));
  assert.equal(record.transcript, speech);
  assert.deepEqual(record.notes, notes);
  assert.equal(calls, 1);
  const duplicate = await server.importDrive(driveLink);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { id, duplicate: true });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);
});

test('validates import requests, blocks parallel jobs and releases the slot after a download error', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(release);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  let paid = 0;
  const ai = { transcribe: async () => { paid++; return speech; }, summarize: async () => notes };
  const driveRequest = async (...args) => {
    calls++;
    if (calls !== 1) return fakeDrive(mp4)(...args);
    entered();
    await blocked;
    return new Response(null, { status: 429 });
  };
  const server = await app(t, ai, undefined, driveRequest);
  assert.equal((await server.importDrive('https://drive.google.com.example.test/file/d/Synthetic_ID/view')).status, 400);
  assert.equal((await server.importDrive('x'.repeat(4097))).status, 413);
  assert.equal(calls, 0);

  const attempt = server.importDrive(driveLink);
  await started;
  try {
    const [record] = await (await server.get('/api/meetings')).json();
    assert.equal(record.phase, 'download');
    assert.equal((await server.upload('busy.mp4', mp4)).status, 409);
    assert.equal((await server.importDrive(driveLink)).status, 409);
    assert.equal((await server.remove(record.id)).status, 409);
  } finally { release(); }

  const error = await attempt;
  assert.equal(error.status, 422);
  const failed = await status(server, (await error.json()).id);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /ограничил скачивание/);
  assert.equal(paid, 0);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);

  const imported = await server.importDrive(driveLink);
  assert.equal(imported.status, 202);
  assert.equal((await done(server, (await imported.json()).id)).status, 'ready');
  assert.equal(paid, 1);
});

test('restores interrupted import state and blocks repeat AI calls for the same bytes', async t => {
  let paid = 0;
  const ai = {
    transcribe: async () => { paid++; throw new Error('Indeterminate provider failure'); },
    summarize: async () => assert.fail('No transcript'),
  };
  const server = await app(t, ai, undefined, fakeDrive(mp4));
  const first = await server.importDrive(driveLink);
  assert.equal(first.status, 202);
  const { id } = await first.json();
  assert.equal((await done(server, id)).status, 'error');
  assert.equal(paid, 1);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);
  await server.stop();

  const recordPath = path.join(server.dataDir, id + '.json');
  const persisted = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(persisted.aiStarted, true);
  await writeFile(recordPath, JSON.stringify({ ...persisted, status: 'processing', phase: 'transcription' }));
  const directory = path.join(server.dataDir, 'work', id);
  await mkdir(directory);
  await writeFile(path.join(directory, 'source.mp4'), mp4);
  const restarted = await app(t, ai, server.dataDir, fakeDrive(mp4));
  assert.equal((await status(restarted, id)).status, 'error');
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);
  for (const response of [
    await restarted.importDrive(driveLink),
    await restarted.upload('same.mp4', mp4),
  ]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).id, id);
  }
  assert.deepEqual((await (await restarted.get('/api/meetings')).json()).map(record => record.id), [id]);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);
  assert.equal(paid, 1);
  await restarted.stop();
});

test('serves the single page and history with no key and rejects uploads', async t => {
  const server = await app(t);
  assert.match(await (await server.get('/')).text(), /AI Meeting Analyzer Lite/);
  for (const file of ['/app.js', '/style.css']) assert.equal((await server.get(file)).status, 200);
  assert.deepEqual(await (await server.get('/api/meetings')).json(), []);
  assert.equal((await server.upload('test.mp4', Buffer.from('x'))).status, 503);
});

test('processes MP4/AAC and WebM/Opus, persists transcript and notes, and cleans working files', async t => {
  const extensions = [];
  const server = await app(t, {
    async transcribe(audio) {
      extensions.push(path.extname(audio));
      assert.deepEqual((await probe(audio)).streams.map(s => s.codec_type), ['audio']);
      return speech;
    },
    summarize: async text => {
      assert.equal(text, speech);
      return notes;
    },
  });
  const id = await submit(server, 'Встреча.mp4', mp4);
  const second = await done(server, id);
  assert.equal(second.status, 'ready', second.error);
  assert.equal(second.name, 'Встреча.mp4');
  assert.equal(second.transcript, speech);
  assert.deepEqual(second.notes, notes);
  const webmId = await submit(server, 'Вторая.webm', webm);
  const other = await done(server, webmId);
  assert.equal(other.status, 'ready', other.error);
  assert.equal(other.audioMode, 'copy');
  assert.deepEqual(extensions, ['.m4a', '.webm']);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);
  assert.ok(Date.parse(second.addedAt));
  await server.stop();
  const restarted = await app(t, undefined, server.dataDir);
  assert.deepEqual(await status(restarted, id), second);
  assert.deepEqual((await (await restarted.get('/api/meetings')).json()).map(record => record.id), [webmId, id]);
  await restarted.stop();
});

test('uses MP3 for incompatible MP4 audio without retransmission', async t => {
  let calls = 0;
  const server = await app(t, {
    async transcribe(audio) {
      calls++;
      assert.equal(path.extname(audio), '.mp3');
      assert.equal((await probe(audio)).streams[0].codec_name, 'mp3');
      return speech;
    },
    summarize: async () => notes,
  });
  const record = await done(server, await submit(server, 'alac.mp4', alac));
  assert.equal(record.status, 'ready', record.error);
  assert.equal(record.audioMode, 'mp3');
  assert.equal(calls, 1);
});

test('rejects unsupported filename, size, foreign origin, broken media, no audio and MKV disguised as WebM', async t => {
  let calls = 0;
  const server = await app(t, { transcribe: async () => { calls++; } });
  assert.equal((await server.upload('../outside.mp4', Buffer.from('x'))).status, 400);
  assert.equal((await server.upload('wrong.exe', Buffer.from('x'))).status, 400);
  assert.equal((await server.upload('empty.mp4', Buffer.alloc(0))).status, 413);
  const oversizedStatus = await new Promise((resolve, reject) => {
    const upload = request(server.origin + '/api/meetings', {
      method: 'POST', headers: { 'x-file-name': 'huge.mp4', 'content-length': '50000001' },
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    upload.on('error', reject);
    upload.setTimeout(3000, () => upload.destroy(new Error('Expected size rejection before receiving body')));
    upload.flushHeaders();
  });
  assert.equal(oversizedStatus, 413);
  assert.equal((await server.upload('x.mp4', Buffer.from('x'), { origin: 'https://foreign.example' })).status, 403);
  for (const [name, content, message] of [
    ['bad.mp4', Buffer.from('not a video'), /Не удалось прочитать/],
    ['silent.mp4', noAudio, /нет аудиодорожки/],
    ['fake.webm', mkv, /Содержимое файла/],
    ['long.mp4', tooLong, /до 5 минут/],
  ]) {
    const record = await done(server, await submit(server, name, content));
    assert.equal(record.status, 'error');
    assert.match(record.error, message);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(path.join(server.dataDir, 'work')), []);
});

test('keeps the transcript when all items are rejected, prevents parallel jobs and does not retry', async t => {
  const gate = Promise.withResolvers();
  const reached = Promise.withResolvers();
  let calls = 0;
  const server = await app(t, {
    transcribe: async () => speech,
    async summarize() {
      calls++;
      reached.resolve();
      await gate.promise;
      return { summary: [], decisions: [{ text: 'Ложное решение', evidence: 'В транскрипте такого нет' }], tasks: [], questions: [] };
    },
  });
  const id = await submit(server, 'test.mp4', mp4);
  try {
    await Promise.race([reached.promise, wait(5000, undefined, { ref: false }).then(() => { throw new Error('No notes phase'); })]);
    const working = await status(server, id);
    assert.equal(working.status, 'processing');
    assert.equal(working.transcript, speech);
    assert.equal((await server.remove(id)).status, 409);
    assert.equal(JSON.parse(await readFile(path.join(server.dataDir, id + '.json'), 'utf8')).status, 'processing');
    assert.equal((await server.upload('busy.webm', webm)).status, 409);
  } finally {
    gate.resolve();
  }
  const failed = await done(server, id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.transcript, speech);
  assert.match(failed.error, /Ни один пункт.*Транскрипт сохранён/);
  assert.equal(failed.notes, undefined);
  assert.equal(failed.notesWarning, undefined);
  const saved = JSON.parse(await readFile(path.join(server.dataDir, id + '.json'), 'utf8'));
  assert.deepEqual(saved.diagnostic, {
    kind: 'notes_validation', rejected: [{ section: 'decisions', index: 0, code: 'quote_not_found' }],
  });
  assert.equal(calls, 1);
});

test('keeps valid items, displays a warning and persists the partial result across restart', async t => {
  const draft = {
    summary: [{ text: ' ', evidence: speech }, ...notes.summary],
    decisions: [...notes.decisions,
      { text: 'sk-rejected-fixture', evidence: 'Конфиденциальный отклонённый фрагмент' },
      { text: 'Запуск согласован.', evidence: 'запуск согласован.' },
    ],
    tasks: [{ text: 'Проверить отчёт.', evidence: '\t\n' }, ...notes.tasks],
    questions: [{ text: 'Вопрос об отчёте.', evidence: 'Надо проверить, отчёт.' }],
  };
  const server = await app(t, { transcribe: async () => speech, summarize: async () => draft });
  const id = await submit(server, 'partial.mp4', alac);
  const record = await done(server, id);
  assert.equal(record.status, 'ready', record.error);
  assert.equal(record.transcript, speech);
  assert.deepEqual(record.notes, notes);
  assert.match(record.notesWarning, /Количество исключённых пунктов — 5\./);
  assert.equal(record.diagnostic, undefined);
  const saved = await readFile(path.join(server.dataDir, id + '.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved).diagnostic, {
    kind: 'notes_validation', rejected: [
      { section: 'summary', index: 0, code: 'invalid_text' },
      { section: 'decisions', index: 1, code: 'quote_not_found' },
      { section: 'decisions', index: 2, code: 'quote_not_found' },
      { section: 'tasks', index: 0, code: 'invalid_evidence' },
      { section: 'questions', index: 0, code: 'quote_not_found' },
    ],
  });
  assert.doesNotMatch(saved, /sk-rejected-fixture|Конфиденциальный отклонённый фрагмент/);
  await server.stop();
  const restarted = await app(t, undefined, server.dataDir);
  const loaded = await status(restarted, id);
  assert.deepEqual(loaded, record);
  const page = await historyPage([loaded]);
  assert.ok(page.detail.children.some(element => element.textContent === record.notesWarning));
  await restarted.stop();
});

test('matches NFC and whitespace differences in both transcript and evidence', async t => {
  const transcript = 'Ещё рано. Первыи\u0306 отчёт готов.';
  const draft = {
    summary: [{ text: 'Ещё рано.', evidence: 'Еще\u0308 \n\t рано.' }],
    decisions: [{ text: 'Первый отчёт готов.', evidence: 'Первый отчёт готов.' }],
    tasks: [], questions: [],
  };
  const server = await app(t, { transcribe: async () => transcript, summarize: async () => draft });
  const record = await done(server, await submit(server, 'unicode.mp4', alac));
  assert.equal(record.status, 'ready', record.error);
  assert.deepEqual(record.notes, draft);
  assert.equal(record.notesWarning, undefined);
});

test('accepts four empty sections as a complete result', async t => {
  const emptyNotes = { summary: [], decisions: [], tasks: [], questions: [] };
  const server = await app(t, { transcribe: async () => speech, summarize: async () => emptyNotes });
  const record = await done(server, await submit(server, 'empty-notes.mp4', alac));
  assert.equal(record.status, 'ready', record.error);
  assert.deepEqual(record.notes, emptyNotes);
  assert.equal(record.transcript, speech);
  assert.equal(record.notesWarning, undefined);
});

test('reports a separate structure error and retains the transcript for missing or non-array sections', async t => {
  const malformed = { summary: notes.summary, decisions: { text: 'rejected-structure-content' }, tasks: [] };
  const server = await app(t, { transcribe: async () => speech, summarize: async () => malformed });
  const id = await submit(server, 'bad-notes.mp4', alac);
  const record = await done(server, id);
  assert.equal(record.status, 'error');
  assert.match(record.error, /Неверная структура конспекта.*Транскрипт сохранён/);
  assert.equal(record.transcript, speech);
  assert.equal(record.notes, undefined);
  const saved = await readFile(path.join(server.dataDir, id + '.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved).diagnostic, {
    kind: 'notes_validation', reason: 'invalid_structure', invalidSections: ['decisions', 'questions'],
  });
  assert.doesNotMatch(saved, /rejected-structure-content/);
});

function meetingFixture(name, status = 'ready') {
  return { id: randomUUID(), name, addedAt: new Date().toISOString(), status, transcript: speech, notes };
}

async function appWithHistory(t, records) {
  const initial = await app(t);
  await initial.stop();
  for (const record of records) {
    await writeFile(path.join(initial.dataDir, record.id + '.json'), JSON.stringify(record));
  }
  return app(t, undefined, initial.dataDir);
}

test('deletes only the selected JSON, returns 404 on repeat and stays deleted after restart', async t => {
  const removed = meetingFixture('Удаляемая.mp4');
  const kept = meetingFixture('Сохраняемая.mp4');
  const server = await appWithHistory(t, [removed, kept]);
  const removedFile = path.join(server.dataDir, removed.id + '.json');
  const keptFile = path.join(server.dataDir, kept.id + '.json');
  const original = await readFile(keptFile);
  const response = await server.remove(removed.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: removed.id });
  await assert.rejects(readFile(removedFile), { code: 'ENOENT' });
  assert.deepEqual(await readFile(keptFile), original);
  assert.equal((await server.remove(removed.id)).status, 404);
  assert.equal((await server.get('/api/meetings/' + removed.id)).status, 404);
  assert.deepEqual((await (await server.get('/api/meetings')).json()).map(item => item.id), [kept.id]);
  await server.stop();
  const restarted = await app(t, undefined, server.dataDir);
  assert.equal((await restarted.get('/api/meetings/' + removed.id)).status, 404);
  assert.deepEqual(await status(restarted, kept.id), kept);
  assert.deepEqual((await (await restarted.get('/api/meetings')).json()).map(item => item.id), [kept.id]);
  await restarted.stop();
});

test('rejects invalid IDs, traversal and foreign origins before deletion', async t => {
  const record = meetingFixture('Сохраняемая.mp4');
  const server = await appWithHistory(t, [record]);
  const file = path.join(server.dataDir, record.id + '.json');
  const original = await readFile(file);
  assert.equal((await server.remove('not-a-uuid')).status, 404);
  assert.equal((await server.remove(randomUUID())).status, 404);
  assert.equal((await server.remove(record.id, { Origin: 'https://foreign.example' })).status, 403);
  for (const suffix of ['../' + record.id, '%2e%2e%2f' + record.id, record.id + '%5c..']) {
    const code = await new Promise((resolve, reject) => {
      const deletion = request(server.origin, { method: 'DELETE', path: '/api/meetings/' + suffix }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      deletion.on('error', reject);
      deletion.end();
    });
    assert.equal(code, 404);
  }
  assert.deepEqual(await readFile(file), original);
});

test('reports a deletion failure and keeps the history when the target is not a regular file', async t => {
  const blocked = meetingFixture('Недоступная.mp4');
  const kept = meetingFixture('Сохраняемая.mp4');
  const server = await appWithHistory(t, [blocked, kept]);
  const target = path.join(server.dataDir, blocked.id + '.json');
  await rename(target, target + '.saved');
  await mkdir(target);
  const response = await server.remove(blocked.id);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Не удалось удалить встречу/);
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await status(server, blocked.id), blocked);
  assert.deepEqual(await status(server, kept.id), kept);
  await server.stop();
});

async function historyPage(records, { confirm = () => true, deleteError } = {}) {
  let activeElement;
  class Element {
    constructor(tag) { this.tag = tag; }
    children = [];
    dataset = {};
    listeners = {};
    classList = { toggle() {} };
    append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    get childElementCount() { return this.children.length; }
    setAttribute() {}
    addEventListener(event, handler) { this.listeners[event] = handler; }
    focus() { activeElement = this; }
    querySelectorAll(selector) {
      const matches = child => selector === 'button[data-id]' ? child.tag === 'button' && child.dataset.id : child.className === 'delete-meeting';
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
  }
  const elements = Object.fromEntries(['video', 'notice', 'history', 'empty', 'detail'].map(id => [id, new Element(id)]));
  const remaining = new Map(records.map(record => [record.id, record]));
  const deletions = [];
  const context = createContext({
    document: { querySelector: selector => elements[selector.slice(1)], createElement: tag => new Element(tag), get activeElement() { return activeElement; } },
    window: { confirm },
    setInterval() {},
    fetch: async (url, options) => {
      if (url === '/api/meetings') return Response.json([...remaining.values()]);
      const id = url.split('/').at(-1);
      if (options?.method === 'DELETE') {
        deletions.push(id);
        if (deleteError) return Response.json({ error: deleteError }, { status: 500 });
        remaining.delete(id);
        return Response.json({ id });
      }
      return Response.json(remaining.get(id) ?? { error: 'Встреча не найдена.' }, { status: remaining.has(id) ? 200 : 404 });
    },
  });
  runInContext(await readFile(new URL('./public/app.js', import.meta.url), 'utf8'), context);
  await runInContext('refresh()', context);
  return { ...elements, deletions, button: id => elements.history.querySelectorAll('.delete-meeting').find(button => button.dataset.deleteId === id) };
}

test('history UI cancels deletion, then updates the list and details after confirmation', async () => {
  const first = meetingFixture('Первая.mp4');
  const second = meetingFixture('Вторая.mp4');
  let approved = false;
  const page = await historyPage([first, second], { confirm: message => {
    assert.equal(message, 'Удалить эту встречу из истории?');
    return approved;
  } });
  await page.button(first.id).listeners.click();
  assert.deepEqual(page.deletions, []);
  assert.equal(page.history.childElementCount, 2);
  assert.equal(page.detail.children[0].textContent, first.name);
  approved = true;
  await page.button(first.id).listeners.click();
  assert.deepEqual(page.deletions, [first.id]);
  assert.equal(page.history.childElementCount, 1);
  assert.equal(page.detail.children[0].textContent, second.name);
  await page.button(second.id).listeners.click();
  assert.equal(page.history.childElementCount, 0);
  assert.equal(page.empty.hidden, false);
  assert.equal(page.detail.children[0].textContent, 'Результат');
});

test('history UI disables deletion during processing and preserves the list on an error', async () => {
  const working = meetingFixture('Обработка.mp4', 'processing');
  const ready = meetingFixture('Готовая.mp4');
  let prompts = 0;
  const page = await historyPage([working, ready], { confirm: () => { prompts++; return true; }, deleteError: 'Ошибка диска.' });
  assert.equal(page.button(working.id).disabled, true);
  await page.button(working.id).listeners.click();
  assert.equal(prompts, 0);
  await page.button(ready.id).listeners.click();
  assert.deepEqual(page.deletions, [ready.id]);
  assert.match(page.notice.textContent, /Не удалось удалить встречу.*Ошибка диска/);
  assert.equal(page.history.childElementCount, 2);
  assert.equal(page.button(ready.id).disabled, false);
});

test('recovers an interrupted job without calling AI', async t => {
  const first = await app(t);
  await first.stop();
  const id = randomUUID();
  const directory = path.join(first.dataDir, 'work', id);
  await mkdir(directory);
  await writeFile(path.join(directory, 'source.mp4'), mp4);
  await writeFile(path.join(first.dataDir, id + '.json'), JSON.stringify({
    id, name: 'interrupted.mp4', addedAt: new Date().toISOString(), status: 'processing', transcript: speech,
  }));
  const server = await app(t, undefined, first.dataDir);
  const record = await status(server, id);
  assert.equal(record.status, 'error');
  assert.match(record.error, /перезапуском/);
  assert.equal(record.transcript, speech);
  assert.deepEqual(await readdir(path.join(first.dataDir, 'work')), []);
  await server.stop();
});

test('constructs the two OpenAI requests and parses the Responses output with a local fetch stub', async () => {
  const calls = [];
  const ai = openAI('test-only', async (url, request) => {
    calls.push(url);
    assert.equal(request.headers.Authorization, 'Bearer test-only');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    if (url.endsWith('/audio/transcriptions')) {
      assert.equal(request.body.get('model'), 'gpt-transcribe');
      const audio = request.body.get('file');
      assert.equal(audio.type, 'audio/mpeg');
      assert.equal(audio.size, 4);
      return Response.json({ text: speech });
    }
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'gpt-5.6-luna');
    assert.equal(body.input, speech);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(notes) },
    ] }] });
  });
  const audio = path.join(fixtures, 'stub.mp3');
  await writeFile(audio, 'stub');
  assert.equal(await ai.transcribe(audio), speech);
  assert.deepEqual(await ai.summarize(speech), notes);
  assert.deepEqual(calls, ['https://api.openai.com/v1/audio/transcriptions', 'https://api.openai.com/v1/responses']);
});

test('handles a provider error without retrying or exposing its response body', async () => {
  let calls = 0;
  const ai = openAI('test-only', async () => {
    calls++;
    return Response.json({ error: 'never shown' }, { status: 429 });
  });
  await assert.rejects(ai.summarize(speech), error => /баланс/.test(error.message) && !error.message.includes('never shown'));
  assert.equal(calls, 1);
});

const endpoint = 'audio/transcriptions';
const reqHeaders = { 'x-request-id': 'req_offline_42' };

async function checkAudioFailure(mock, message, details) {
  let calls = 0;
  const ai = openAI('offline-token', (...args) => {
    calls++;
    assert.equal(args[0], 'https://api.openai.com/v1/' + endpoint);
    return mock(...args);
  });
  const audio = path.join(fixtures, 'diagnostic.mp3');
  await writeFile(audio, 'synthetic');
  await assert.rejects(ai.transcribe(audio), error => {
    assert.match(error.message, message);
    assert.deepEqual(JSON.parse(JSON.stringify(error.diagnostic)), { endpoint, ...details });
    assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostic: error.diagnostic }), /private sample|offline-token|sk-secret-fixture/);
    return true;
  });
  assert.equal(calls, 1);
}

for (const [httpStatus, apiCode, apiType, message] of [
  [401, 'invalid_api_key', 'invalid_request_error', /доступ проекта/],
  [403, 'permission_denied', 'invalid_request_error', /доступ проекта/],
  [429, 'project_spend_limit_exceeded', 'insufficient_quota', /баланс или лимиты/],
  [500, 'internal_error', 'server_error', /не смог обработать запрос/],
]) {
  test('records OpenAI HTTP ' + httpStatus + ' with safe fields only', async () => {
    await checkAudioFailure(() => Response.json({
      error: { code: apiCode, type: apiType, message: 'private sample' },
    }, { status: httpStatus, headers: reqHeaders }), message, {
      kind: 'http', httpStatus, requestId: reqHeaders['x-request-id'], apiCode, apiType,
    });
  });
}

test('keeps HTTP status when cancellation of an oversized body rejects', async () => {
  let cancellations = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(17 * 1024)); },
    cancel() {
      cancellations++;
      throw new Error('private sample');
    },
  });
  await checkAudioFailure(() => new Response(body, { status: 403, headers: reqHeaders }), /доступ проекта/, {
    kind: 'http', httpStatus: 403, requestId: reqHeaders['x-request-id'],
  });
  assert.equal(cancellations, 1);
});

test('keeps HTTP status when an error response body is locked', async () => {
  const response = Response.json({ error: 'private sample' }, { status: 403, headers: reqHeaders });
  const reader = response.body.getReader();
  try {
    await checkAudioFailure(() => response, /доступ проекта/, {
      kind: 'http', httpStatus: 403, requestId: reqHeaders['x-request-id'], bodyFailure: 'read', transportCode: 'ERR_INVALID_STATE',
    });
  } finally {
    reader.releaseLock();
  }
});

test('distinguishes a timeout from a network failure before response headers', async () => {
  await checkAudioFailure(() => { throw new DOMException('private sample', 'TimeoutError'); }, /не ответил вовремя/, {
    kind: 'timeout', stage: 'fetch',
  });
  await checkAudioFailure(() => {
    throw new TypeError('private sample', { cause: { code: 'ENOTFOUND' } });
  }, /соединиться/, {
    kind: 'network', stage: 'fetch', transportCode: 'ENOTFOUND',
  });
});

test('retains response metadata when reading times out after headers', async () => {
  const body = new ReadableStream({
    start(controller) { controller.error(new DOMException('private sample', 'TimeoutError')); },
  });
  await checkAudioFailure(() => new Response(body, { headers: reqHeaders }), /не ответил вовремя/, {
    kind: 'timeout', stage: 'read', httpStatus: 200, requestId: reqHeaders['x-request-id'],
  });
});

test('distinguishes read, JSON parse, and format errors on successful HTTP responses', async () => {
  const details = { kind: 'response', httpStatus: 200, requestId: reqHeaders['x-request-id'] };
  const body = new ReadableStream({
    start(controller) { controller.error(new Error('private sample')); },
  });
  await checkAudioFailure(() => new Response(body, { headers: reqHeaders }), /прочитать ответ/, {
    ...details, stage: 'read',
  });
  await checkAudioFailure(() => new Response('<html>private sample</html>', { headers: reqHeaders }), /неожиданном формате/, {
    ...details, stage: 'parse',
  });
  await checkAudioFailure(() => Response.json({ text: 23 }, { headers: reqHeaders }), /неожиданном формате/, {
    ...details, stage: 'format',
  });
});

test('omits values that resemble secrets or do not fit the metadata fields', async () => {
  await checkAudioFailure(() => Response.json({
    error: { code: 'sk-secret-fixture', type: 'private sample' },
  }, { status: 500, headers: { 'x-request-id': 'offline-token' } }), /не смог обработать запрос/, {
    kind: 'http', httpStatus: 500,
  });
});

test('persists safe provider diagnostics locally without returning them to the page', async t => {
  let calls = 0;
  const server = await app(t, openAI('offline-token', () => {
    calls++;
    return Response.json({
      error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'private sample' },
    }, { status: 429, headers: reqHeaders });
  }));
  const id = await submit(server, 'diagnostics.mp4', alac);
  const record = await done(server, id);
  assert.equal(record.status, 'error');
  assert.match(record.error, /баланс или лимиты/);
  assert.equal(record.diagnostic, undefined);
  const persisted = await readFile(path.join(server.dataDir, id + '.json'), 'utf8');
  assert.deepEqual(JSON.parse(persisted).diagnostic, {
    endpoint, kind: 'http', httpStatus: 429, requestId: 'req_offline_42',
    apiCode: 'insufficient_quota', apiType: 'insufficient_quota',
  });
  assert.doesNotMatch(persisted, /private sample|offline-token/);
  assert.equal(calls, 1);
});
