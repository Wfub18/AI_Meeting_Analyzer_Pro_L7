import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { probe } from '../poc/media.mjs';

const MAX_BYTES = 50_000_000;
const FILENAME = 'source.mp4';
const FILES_API = 'https://www.googleapis.com/drive/v3/files/';
const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const CHECKSUMS = [
  ['sha256Checksum', 'sha256', /^[a-f0-9]{64}$/i],
  ['sha1Checksum', 'sha1', /^[a-f0-9]{40}$/i],
  ['md5Checksum', 'md5', /^[a-f0-9]{32}$/i],
];
const FIELDS = ['id', 'name', 'mimeType', 'size', 'capabilities(canDownload)',
  ...CHECKSUMS.map(([field]) => field)].join(',');

class DriveImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseDriveLink(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  const match = input.length <= 2048 && !/[\u0000-\u0020\u007f\\]/.test(input) &&
    /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{1,200})(?:\/(?:view|preview))?\/?(?:\?[^#]*)?(?:#.*)?$/.exec(input);
  if (!match) {
    throw new DriveImportError('INVALID_LINK', 'Вставьте публичную HTTPS-ссылку Google Drive на отдельный файл.');
  }
  const keys = new URL(input).searchParams.getAll('resourcekey');
  if (keys.length > 1 || (keys.length === 1 && !TOKEN.test(keys[0]))) {
    throw new DriveImportError('INVALID_RESOURCE_KEY', 'Некорректный resourcekey. Скопируйте ссылку целиком из Google Drive.');
  }
  return { fileId: match[1], resourceKey: keys[0] };
}

async function discard(response) {
  if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
}

async function driveGet(url, { request, headers, signal }) {
  const response = await request(url, { headers, redirect: 'manual', signal });
  if (response.status === 200) return response;

  if (response.status >= 300 && response.status < 400) {
    await discard(response);
    throw new DriveImportError('UNEXPECTED_REDIRECT', 'Drive вернул перенаправление. Импорт остановлен.');
  }
  const error = [400, 403].includes(response.status)
    ? (await response.json().catch(() => null))?.error : null;
  await discard(response);
  signal.throwIfAborted();

  const reasons = [error?.errors, error?.details].flatMap(items =>
    Array.isArray(items) ? items.map(item => item?.reason) : []);
  if (response.status === 429 ||
      reasons.some(reason => /(?:quota|ratelimit|resource_exhausted)/i.test(reason ?? ''))) {
    throw new DriveImportError('DRIVE_QUOTA', 'Google Drive ограничил скачивание или частоту запросов. Попробуйте позже.');
  }
  if (response.status === 401 ||
      reasons.some(reason => ['API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'SERVICE_DISABLED',
        'accessNotConfigured', 'keyInvalid'].includes(reason))) {
    throw new DriveImportError('DRIVE_CONFIGURATION', 'Проверьте API-ключ и включение Google Drive API в Google Cloud.');
  }
  if ([403, 404].includes(response.status)) {
    throw new DriveImportError('FILE_UNAVAILABLE', 'Файл недоступен для скачивания. Проверьте публичный доступ и вставьте полную ссылку.');
  }
  throw new DriveImportError('DRIVE_RESPONSE', 'Google Drive вернул неожиданный ответ. Попробуйте позже.');
}

async function readMetadata(url, options, fileId) {
  const response = await driveGet(url, options);
  const record = await response.json().catch(() => null);
  options.signal.throwIfAborted();
  if (record?.id !== fileId || typeof record.name !== 'string' || !record.name.trim()) {
    throw new DriveImportError('INVALID_METADATA', 'Google Drive вернул неполные метаданные файла.');
  }
  if (record.mimeType !== 'video/mp4') {
    throw new DriveImportError('UNSUPPORTED_TYPE', 'Для этого PoC выберите отдельный файл MP4.');
  }
  if (record.capabilities?.canDownload !== true) {
    throw new DriveImportError('DOWNLOAD_FORBIDDEN', 'Google Drive не разрешает скачивать этот файл.');
  }
  if (typeof record.size !== 'string' || !/^[1-9][0-9]*$/.test(record.size)) {
    throw new DriveImportError('INVALID_SIZE', 'Google Drive не сообщил корректный размер непустого файла.');
  }
  const bytes = Number(record.size);
  if (bytes > MAX_BYTES) {
    throw new DriveImportError('FILE_TOO_LARGE', 'Допустимый размер MP4 — до 50 000 000 байт.');
  }

  const checksum = CHECKSUMS.find(([field]) => Object.hasOwn(record, field));
  if (checksum && (typeof record[checksum[0]] !== 'string' || !checksum[2].test(record[checksum[0]]))) {
    throw new DriveImportError('INVALID_CHECKSUM', 'Google Drive вернул контрольную сумму в неожиданном формате.');
  }
  return { name: record.name, bytes, checksum: checksum && {
    algorithm: checksum[1], value: record[checksum[0]].toLowerCase(),
  } };
}

export async function downloadDriveMp4({ link, apiKey, directory, request = fetch, timeoutMs = 60_000 }) {
  const { fileId, resourceKey } = parseDriveLink(link);
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!TOKEN.test(key)) {
    throw new DriveImportError('MISSING_API_KEY', 'Задайте GOOGLE_DRIVE_API_KEY в окружении запуска.');
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { 'x-goog-api-key': key };
  if (resourceKey) headers['x-goog-drive-resource-keys'] = fileId + '/' + resourceKey;
  const options = { request, headers, signal };
  const metadataUrl = new URL(fileId, FILES_API);
  metadataUrl.searchParams.set('fields', FIELDS);
  const mediaUrl = new URL(fileId, FILES_API);
  mediaUrl.searchParams.set('alt', 'media');
  const file = path.join(directory, FILENAME);
  let created = false;
  let mediaResponse;
  try {
    const metadata = await readMetadata(metadataUrl, options, fileId);
    mediaResponse = await driveGet(mediaUrl, options);
    const mediaType = mediaResponse.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!mediaResponse.body || !['video/mp4', 'application/octet-stream', 'application/mp4'].includes(mediaType)) {
      throw new DriveImportError('UNEXPECTED_CONTENT', 'Вместо MP4 Google Drive вернул другой тип данных.');
    }

    const length = mediaResponse.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== metadata.bytes)) {
      throw new DriveImportError('SIZE_MISMATCH', 'Размер ответа не совпадает с метаданными Google Drive.');
    }

    let received = 0;
    const sha256 = createHash('sha256');
    const algorithm = metadata.checksum?.algorithm;
    const extraHash = algorithm && algorithm !== 'sha256' ? createHash(algorithm) : null;
    const verify = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > metadata.bytes) {
          return callback(new DriveImportError('SIZE_MISMATCH', 'Получено больше байтов, чем указано в Google Drive.'));
        }
        sha256.update(chunk);
        extraHash?.update(chunk);
        callback(null, chunk);
      },
    });

    const handle = await open(file, 'wx');
    created = true;
    await pipeline(Readable.fromWeb(mediaResponse.body), verify, handle.createWriteStream(), { signal });
    if (received !== metadata.bytes) {
      throw new DriveImportError('SIZE_MISMATCH', 'Скачивание прервалось. Размер файла не совпадает с метаданными.');
    }
    const digest = sha256.digest('hex');
    if (metadata.checksum && (extraHash?.digest('hex') ?? digest) !== metadata.checksum.value) {
      throw new DriveImportError('CHECKSUM_MISMATCH', 'Контрольная сумма скачанного файла не совпадает с Google Drive.');
    }
    return { file, fileId, name: metadata.name, bytes: received, sha256: digest, verifiedChecksum: algorithm ?? null };
  } catch (error) {
    if (created) await rm(file, { force: true });
    if (error instanceof DriveImportError) throw error;
    if (signal.aborted) throw new DriveImportError('TIMEOUT', 'Google Drive не завершил передачу за отведённое время.');
    if (error.code === 'EEXIST') throw new DriveImportError('DESTINATION_EXISTS', 'Временный файл уже существует.');
    throw new DriveImportError('TRANSFER_FAILED', 'Не удалось скачать или записать файл Google Drive.');
  } finally {
    if (mediaResponse) await discard(mediaResponse);
  }
}

async function main(link) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meeting-drive-'));
  try {
    const result = await downloadDriveMp4({ link, apiKey: process.env.GOOGLE_DRIVE_API_KEY, directory });
    let media;
    try {
      media = await probe(result.file);
    } catch (error) {
      if (error.code === 'ENOENT') throw new DriveImportError('FFPROBE_REQUIRED', 'Укажите путь к ffprobe через POC_FFPROBE_PATH.');
      throw new DriveImportError('INVALID_VIDEO', 'FFprobe не смог прочитать скачанный MP4.');
    }
    const duration = Number(media.format?.duration);
    const brand = media.format?.tags?.major_brand?.trim() ?? '';
    if (!media.format?.format_name?.split(',').includes('mp4') ||
        !/^(isom|iso[2-9]|mp4[12]|avc1|M4V|dash|MSNV|cmfc|cmfs)$/.test(brand) ||
        !media.streams?.some(stream => stream.codec_type === 'video') ||
        !media.streams?.some(stream => stream.codec_type === 'audio') ||
        !(duration > 0 && duration <= 300.25)) {
      throw new DriveImportError('INVALID_VIDEO', 'Нужен MP4 с видео и аудиодорожкой длительностью до 5 минут.');
    }
    console.log(JSON.stringify({
      name: result.name, bytes: result.bytes, sha256: result.sha256,
      verifiedChecksum: result.verifiedChecksum, durationSeconds: duration,
    }, null, 2));
  } finally {
    await rm(path.join(directory, FILENAME), { force: true });
    await rmdir(directory);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error('Использование: node drive-poc/import.mjs "<публичная ссылка Google Drive>"');
    process.exitCode = 1;
  } else {
    try {
      await main(process.argv[2]);
    } catch (error) {
      console.error(error instanceof DriveImportError ? error.message : 'Не удалось выполнить импорт Google Drive.');
      process.exitCode = 1;
    }
  }
}
