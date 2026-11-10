import { createHash } from 'node:crypto';
import { link as linkFile, mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { checkContainer, probe } from '../poc/media.mjs';
import { parseDriveLink } from './import.mjs';
import { requestHttps } from '../yandex-poc/https.mjs';

const MAX_BYTES = 50_000_000;
const START = 'https://drive.google.com/uc';
const PATHS = new Map([
  ['drive.google.com', '/uc'],
  ['drive.usercontent.google.com', '/download'],
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const TYPES = new Set(['video/mp4', 'application/mp4', 'video/webm', 'application/octet-stream']);

export class PublicDriveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function publicDownloadUrl(link) {
  let input = typeof link === 'string' ? link.trim() : '';
  if (input.startsWith('https://drive.google.com/file/d/')) {
    try {
      const { fileId, resourceKey } = parseDriveLink(input);
      const url = new URL(START);
      url.searchParams.set('export', 'download');
      url.searchParams.set('id', fileId);
      if (resourceKey) url.searchParams.set('resourcekey', resourceKey);
      input = url.href;
    } catch (error) {
      throw new PublicDriveError(error.code, error.message);
    }
  }
  if (input.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(input) || !input.startsWith(START + '?')) {
    throw new PublicDriveError('INVALID_LINK', 'Укажите публичную ссылку скачивания Google Drive вида /uc?export=download&id=…');
  }
  const { searchParams, hash } = new URL(input);
  const ids = searchParams.getAll('id');
  const exports = searchParams.getAll('export');
  const keys = searchParams.getAll('resourcekey');
  if (hash || ids.length !== 1 || !TOKEN.test(ids[0]) || exports.length !== 1 ||
      exports[0] !== 'download' || keys.length > 1 || (keys.length && !TOKEN.test(keys[0])) ||
      [...searchParams.keys()].some(name => !['id', 'export', 'resourcekey'].includes(name))) {
    throw new PublicDriveError('INVALID_LINK', 'Некорректные параметры публичной ссылки Google Drive.');
  }
  const url = new URL(START);
  url.searchParams.set('export', 'download');
  url.searchParams.set('id', ids[0]);
  if (keys.length) url.searchParams.set('resourcekey', keys[0]);
  return url;
}

function redirectUrl(location, base) {
  const url = typeof location === 'string' && location.length <= 8192 &&
    !/[\u0000-\u0020\u007f\\]/.test(location) && URL.parse(location, base);
  if (!url || url.protocol !== 'https:' || PATHS.get(url.hostname) !== url.pathname ||
      url.username || url.password || url.port || url.hash) {
    throw new PublicDriveError('UNSAFE_REDIRECT', 'Google Drive вернул неподдерживаемый адрес перенаправления.');
  }
  return url;
}

async function discard(response) {
  if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
}

async function fetchDownload(url, request, signal, trace) {
  for (let hops = 0; ; hops++) {
    const step = { host: url.hostname };
    trace.push(step);
    const response = await request(url, { signal, redirect: 'manual' });
    step.status = response.status;
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    await discard(response);
    if (!location || hops >= 3) throw new PublicDriveError('REDIRECT_LIMIT', 'Цепочка перенаправлений Google Drive не завершилась.');
    url = redirectUrl(location, url);
  }
}

function originalName(disposition, extension) {
  if (!disposition || disposition.length > 2048) return null;
  const parts = /^(?:attachment|inline)((?:\s*;\s*[\w-]+\*?\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^";\s]+))*)\s*$/i.exec(disposition);
  if (!parts) return null;
  const names = new Map();
  for (const [, key, quoted, token] of parts[1].matchAll(/;\s*([\w-]+\*?)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^";\s]+))/g)) {
    const lower = key.toLowerCase();
    if (lower !== 'filename' && lower !== 'filename*') continue;
    if (names.has(lower)) return null;
    names.set(lower, quoted ?? token);
  }
  const extended = /^UTF-8'[a-z0-9-]*'(.*)$/i.exec(names.get('filename*') ?? '');
  let name = names.get('filename') ?? '';
  if (extended) {
    try { name = decodeURIComponent(extended[1]); } catch { return null; }
  } else if (/[^\x20-\x7e]/.test(name)) {
    return null;
  }
  name = name.normalize('NFC');
  if (name !== name.trim() || name.startsWith('.') ||
      !/^[^/\\<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,220}\.(mp4|webm)$/iu.test(name) ||
      path.extname(name).toLowerCase() !== extension) return null;
  return name;
}

async function verifyVideo(file, inspect) {
  let media;
  try {
    media = await inspect(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new PublicDriveError('FFPROBE_REQUIRED', 'Укажите путь к FFprobe в POC_FFPROBE_PATH.');
    if (error.message === 'PROCESS_TIMEOUT') throw new PublicDriveError('FFPROBE_TIMEOUT', 'FFprobe не успел проверить видео.');
    throw new PublicDriveError('INVALID_VIDEO', 'FFprobe не смог прочитать скачанное видео.');
  }
  const duration = Number(media?.format?.duration);
  const extension = media?.format?.format_name?.split(',').includes('webm') ? '.webm' : '.mp4';
  try {
    await checkContainer(file, extension, media?.format);
  } catch (error) {
    if (error.message !== 'UNSUPPORTED_CONTAINER') throw error;
    throw new PublicDriveError('INVALID_VIDEO', 'Содержимое файла не соответствует MP4 или WebM.');
  }
  if (!media.streams?.some(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1) ||
      !media.streams?.some(stream => stream.codec_type === 'audio') ||
      !(duration > 0 && duration <= 300.25)) {
    throw new PublicDriveError('INVALID_VIDEO', 'Нужен MP4 или WebM с видео и аудиодорожкой длительностью до 5 минут.');
  }
  return { durationSeconds: duration, extension };
}

export async function downloadPublicDriveVideo({
  link, directory, request = requestHttps, inspect = probe, timeoutMs = 60_000,
}) {
  const url = publicDownloadUrl(link);
  const signal = AbortSignal.timeout(timeoutMs);
  const trace = [];
  let response;
  const ownsDirectory = directory === undefined;
  let file;
  let created = false;
  try {
    response = await fetchDownload(url, request, signal, trace);
    if ([401, 403, 404, 410].includes(response.status)) {
      throw new PublicDriveError('UNAVAILABLE', 'Файл недоступен. Проверьте публичный доступ и разрешение на скачивание.');
    }
    if (response.status === 429) throw new PublicDriveError('QUOTA', 'Google Drive временно ограничил скачивание.');
    if (response.status !== 200) throw new PublicDriveError('UNEXPECTED_RESPONSE', 'Google Drive вернул неожиданный HTTP-ответ.');

    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.body || !TYPES.has(type)) {
      throw new PublicDriveError('UNEXPECTED_CONTENT', 'Google Drive вернул страницу или данные другого типа вместо видео.');
    }
    const length = response.headers.get('content-length');
    const expected = length === null ? null : Number(length);
    if (length !== null && (!/^[0-9]+$/.test(length) || expected === 0)) {
      throw new PublicDriveError('INVALID_LENGTH', 'Google Drive вернул некорректный размер файла.');
    }
    if (expected > MAX_BYTES) throw new PublicDriveError('TOO_LARGE', 'Размер видео должен быть не больше 50 000 000 байт.');

    if (ownsDirectory) directory = await mkdtemp(path.join(tmpdir(), 'meeting-drive-public-'));
    file = path.join(directory, 'source.download');
    let bytes = 0;
    const hash = createHash('sha256');
    const count = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          return callback(new PublicDriveError('TOO_LARGE', 'Размер видео должен быть не больше 50 000 000 байт.'));
        }
        if (expected !== null && bytes > expected) {
          return callback(new PublicDriveError('SIZE_MISMATCH', 'Получено больше байтов, чем указал Google Drive.'));
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const handle = await open(file, 'wx');
    created = true;
    await pipeline(Readable.fromWeb(response.body), count, handle.createWriteStream(), { signal });
    if (!bytes || (expected !== null && bytes !== expected)) {
      throw new PublicDriveError('SIZE_MISMATCH', 'Получен пустой или неполный файл.');
    }
    const { durationSeconds, extension } = await verifyVideo(file, inspect);
    const name = originalName(response.headers.get('content-disposition'), extension) ?? 'Импорт Google Drive' + extension;
    const result = { name, bytes, durationSeconds, sha256: hash.digest('hex'), trace };
    if (ownsDirectory) return result;
    const verifiedFile = path.join(directory, 'source' + extension);
    // Publish under the verified extension without overwriting any existing job file.
    await linkFile(file, verifiedFile);
    return { ...result, file: verifiedFile };
  } catch (error) {
    let failure = error;
    if (!(failure instanceof PublicDriveError)) {
      failure = signal.aborted
        ? new PublicDriveError('TIMEOUT', 'Google Drive не завершил передачу за отведённое время.')
        : error.code === 'UNSAFE_DNS'
          ? new PublicDriveError('UNSAFE_DNS', 'Адрес Google Drive не разрешился в публичный IPv4.')
          : new PublicDriveError('TRANSFER_FAILED', 'Не удалось получить или записать файл Google Drive.');
    }
    failure.trace = trace;
    throw failure;
  } finally {
    await discard(response);
    if (created) await rm(file, { force: true });
    if (ownsDirectory && directory) await rmdir(directory);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error('Использование: node drive-poc/public-download.mjs "<публичная ссылка скачивания Google Drive>"');
    process.exitCode = 1;
  } else {
    try {
      const result = await downloadPublicDriveVideo({ link: process.argv[2] });
      console.log(JSON.stringify({ ...result, temporaryFilesRemoved: true }, null, 2));
    } catch (error) {
      const report = error instanceof PublicDriveError
        ? { code: error.code, message: error.message, trace: error.trace }
        : { code: 'LOCAL_ERROR', message: 'Не удалось выполнить импорт или очистить временные файлы.' };
      console.error(JSON.stringify(report, null, 2));
      process.exitCode = 1;
    }
  }
}
