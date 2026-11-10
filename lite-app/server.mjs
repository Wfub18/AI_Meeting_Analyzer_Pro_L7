import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_VIDEO, MeetingError, openAI, processMeeting } from './meeting.mjs';
import { downloadPublicDriveVideo, PublicDriveError, publicDownloadUrl } from '../drive-poc/public-download.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const idPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const jobName = new RegExp('^' + idPattern + '$');
const resultName = new RegExp('^' + idPattern + '\\.json$');
const assets = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
};
const files = ['source.mp4', 'source.webm', 'source.download', 'copy.m4a', 'copy.webm', 'audio.mp3'];
const repeatError = 'Анализ этого файла уже запускался и завершился ошибкой. Повторный вызов не выполнен.';

async function cleanup(directory) {
  for (const name of files) await rm(path.join(directory, name), { force: true });
  try {
    await rmdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function json(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function uploadName(request) {
  let name;
  try {
    name = decodeURIComponent(request.headers['x-file-name'] ?? '');
  } catch {
    return null;
  }
  return /^[^/\\<>:"|?*\u0000-\u001f]{1,220}\.(mp4|webm)$/i.test(name) ? name : null;
}

export async function start({ dataDir = path.join(here, 'data'), port = 4317, ai, driveRequest } = {}) {
  const jobsDir = path.join(dataDir, 'work');
  const results = new Map();
  let historyDir;
  let active = false;
  let ready = false;
  const server = createServer({ requestTimeout: 125_000, headersTimeout: 15_000 }, (request, response) => {
    route(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) json(response, 500, { error: 'Не удалось сохранить или открыть результат.' });
    });
  });
  const expectedHost = () => '127.0.0.1:' + server.address().port;

  async function save(record) {
    const target = path.join(dataDir, record.id + '.json');
    const temp = target + '.tmp';
    await writeFile(temp, JSON.stringify(record, null, 2), { flush: true });
    await rename(temp, target);
    results.set(record.id, record);
  }

  function previousMeeting(sha256) {
    const matching = [...results.values()].filter(record => record.sha256 === sha256);
    return matching.find(record => record.status === 'ready') ??
      matching.find(record => record.status === 'error' && record.aiStarted);
  }

  async function finish(record, file, directory) {
    const update = async patch => {
      const next = { ...record, ...patch };
      if (patch.phase === 'transcription') next.aiStarted = true;
      await save(next);
      record = next;
    };
    let outcome;
    try {
      const result = await processMeeting({ file, directory, ai, update });
      outcome = { ...result, status: 'ready', phase: null };
    } catch (error) {
      outcome = { status: 'error', phase: null, error: error instanceof MeetingError
        ? error.message : 'Внутренняя ошибка обработки. Проверьте место на диске и перезапустите приложение.' };
      if (error instanceof MeetingError && error.diagnostic) outcome.diagnostic = error.diagnostic;
    }
    try {
      await cleanup(directory);
    } catch {
      outcome.cleanupWarning = 'Не удалось удалить временные медиафайлы. Проверьте каталог data/work после остановки.';
    }
    try {
      await update(outcome);
    } catch {
      results.set(record.id, { ...record, status: 'error', phase: null, error: 'Не удалось сохранить итог на диске.' });
      console.error('Ошибка сохранения встречи', record.id);
    } finally {
      active = false;
    }
  }

  async function accept(request, response) {
    const fail = (code, error) => {
      response.setHeader('Connection', 'close');
      json(response, code, { error });
    };
    if (active) return fail(409, 'Дождитесь завершения текущей обработки.');
    if (!ai) return fail(503, 'Задайте OPENAI_API_KEY на сервере и перезапустите приложение.');
    const name = uploadName(request);
    if (!name) return fail(400, 'Выберите один файл с расширением MP4 или WebM.');
    const size = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO) {
      return fail(413, 'Выберите непустое видео размером до 50 МБ.');
    }
    active = true;
    const id = randomUUID();
    const directory = path.join(jobsDir, id);
    const file = path.join(directory, 'source' + path.extname(name).toLowerCase());
    const record = { id, name, source: 'upload', addedAt: new Date().toISOString(), status: 'processing', phase: 'audio' };
    const hash = createHash('sha256');
    try {
      await mkdir(directory);
      let received = 0;
      await pipeline(request, new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (received > size || received > MAX_VIDEO) return callback(new Error('UPLOAD_LIMIT'));
          hash.update(chunk);
          callback(null, chunk);
        },
      }), createWriteStream(file, { flags: 'wx' }), { signal: AbortSignal.timeout(120_000) });
      if (received !== size) throw new Error('UPLOAD_INCOMPLETE');
      record.sha256 = hash.digest('hex');
      const previous = previousMeeting(record.sha256);
      if (previous) {
        await cleanup(directory);
        active = false;
        if (previous.status === 'ready') return json(response, 202, { id: previous.id });
        return json(response, 409, { id: previous.id, error: repeatError });
      }
      await save(record);
    } catch {
      try {
        await cleanup(directory);
      } catch {
        console.error('Ошибка удаления временных файлов', id);
      } finally {
        active = false;
      }
      if (!response.destroyed) fail(500, 'Не удалось принять видео. Проверьте соединение и место на диске.');
      return;
    }
    json(response, 202, { id });
    void finish(record, file, directory);
  }

  async function importMeeting(request, response) {
    const fail = (code, error, id) => {
      response.setHeader('Connection', 'close');
      json(response, code, { error, id });
    };
    if (active) return fail(409, 'Дождитесь завершения текущей обработки.');
    if (!ai) return fail(503, 'Задайте OPENAI_API_KEY на сервере и перезапустите приложение.');

    let link;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 4096) return fail(413, 'Запрос импорта слишком большой.');
        chunks.push(chunk);
      }
      link = publicDownloadUrl(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.url).href;
    } catch (error) {
      if (!response.destroyed) fail(400, error instanceof PublicDriveError
        ? error.message : 'Передайте публичную ссылку Google Drive в поле url.');
      return;
    }

    // The task slot may have been taken while reading the JSON body.
    if (active) return fail(409, 'Дождитесь завершения текущей обработки.');
    active = true;
    const id = randomUUID();
    const directory = path.join(jobsDir, id);
    const record = {
      id, name: 'Импорт Google Drive', source: 'google-drive',
      addedAt: new Date().toISOString(), status: 'processing', phase: 'download',
    };
    let handedOff = false;
    let responseStatus;
    let responseBody;
    try {
      await mkdir(directory);
      await save(record);
      const imported = await downloadPublicDriveVideo({ link, directory, request: driveRequest });
      const previous = previousMeeting(imported.sha256);
      if (previous) {
        await unlink(path.join(dataDir, id + '.json'));
        results.delete(id);
        responseStatus = previous.status === 'ready' ? 200 : 409;
        responseBody = previous.status === 'ready'
          ? { id: previous.id, duplicate: true }
          : { id: previous.id, error: repeatError };
      } else {
        const next = { ...record, name: imported.name, sha256: imported.sha256, phase: 'audio' };
        await save(next);
        responseStatus = 202;
        responseBody = { id };
        handedOff = true;
        void finish(next, imported.file, directory);
      }
    } catch (error) {
      const known = error instanceof PublicDriveError;
      const message = known ? error.message : 'Не удалось подготовить импорт или сохранить его состояние.';
      responseStatus = known ? 422 : 500;
      responseBody = { error: message };
      if (results.has(id)) {
        const failed = { ...results.get(id), status: 'error', phase: null, error: message };
        try {
          await save(failed);
          responseBody.id = id;
        } catch {
          results.set(id, failed);
          console.error('Ошибка сохранения встречи', id);
        }
      }
    } finally {
      if (!handedOff) {
        try {
          await cleanup(directory);
        } catch {
          console.error('Ошибка удаления временных файлов', id);
        } finally {
          active = false;
        }
      }
    }
    if (!response.destroyed) json(response, responseStatus, responseBody);
  }

  async function removeMeeting(response, id) {
    const record = results.get(id);
    if (!record) return json(response, 404, { error: 'Встреча не найдена.' });
    if (record.status === 'processing') {
      return json(response, 409, { error: 'Дождитесь завершения обработки встречи.' });
    }
    const file = path.join(historyDir, id + '.json');
    try {
      if (await realpath(dataDir) !== historyDir || !(await lstat(file)).isFile() ||
          await realpath(historyDir) !== historyDir) {
        throw new Error('Unexpected history path');
      }
      await unlink(file);
    } catch (error) {
      if (error.code === 'ENOENT') return json(response, 404, { error: 'Файл встречи не найден.' });
      return json(response, 500, { error: 'Не удалось удалить встречу. Проверьте доступ к каталогу истории.' });
    }
    results.delete(id);
    return json(response, 200, { id });
  }

  async function route(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== expectedHost() ||
        (request.headers.origin && request.headers.origin !== 'http://' + expectedHost())) {
      return json(response, 403, { error: 'Разрешён доступ только с локальной страницы приложения.' });
    }
    if (!ready) return json(response, 503, { error: 'Приложение запускается.' });
    const url = request.url;
    const id = url.startsWith('/api/meetings/') ? url.slice('/api/meetings/'.length) : '';
    if (request.method === 'GET') {
      if (Object.hasOwn(assets, url)) {
        const [name, contentType] = assets[url];
        const bytes = await readFile(path.join(here, 'public', name));
        response.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
        return response.end(bytes);
      }
      if (url === '/api/meetings') {
        return json(response, 200, [...results.values()].reverse().sort((a, b) => b.addedAt.localeCompare(a.addedAt))
          .map(({ id, name, source, addedAt, status, phase }) => ({ id, name, source, addedAt, status, phase })));
      }
      if (jobName.test(id) && results.has(id)) {
        const { diagnostic, aiStarted, ...visibleRecord } = results.get(id);
        return json(response, 200, visibleRecord);
      }
    }
    if (request.method === 'DELETE' && jobName.test(id)) return removeMeeting(response, id);
    if (request.method === 'POST' && url === '/api/meetings') return accept(request, response);
    if (request.method === 'POST' && url === '/api/imports') return importMeeting(request, response);
    return json(response, 404, { error: 'Страница или встреча не найдена.' });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    await mkdir(jobsDir, { recursive: true });
    historyDir = await realpath(dataDir);
    for (const entry of await readdir(dataDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const file = path.join(dataDir, name);
      if (name.endsWith('.tmp') && resultName.test(name.slice(0, -4))) await unlink(file);
      if (!resultName.test(name)) continue;
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.id + '.json' !== name) throw new Error('Некорректный идентификатор истории.');
      if (record.status === 'processing') {
        await save({ ...record, status: 'error', phase: null, error: 'Обработка прервана перезапуском. При необходимости загрузите запись снова.' });
      } else {
        results.set(record.id, record);
      }
    }
    for (const entry of await readdir(jobsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && jobName.test(entry.name)) await cleanup(path.join(jobsDir, entry.name));
    }
    ready = true;
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const key = process.env.OPENAI_API_KEY?.trim();
  const server = await start({ ai: key ? openAI(key) : undefined });
  console.log('AI Meeting Analyzer Lite — http://127.0.0.1:' + server.address().port);
  if (!key) console.log('OPENAI_API_KEY отсутствует. История доступна, загрузка отключена.');
}
