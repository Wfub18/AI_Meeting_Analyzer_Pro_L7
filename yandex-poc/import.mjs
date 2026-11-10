import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { probe } from '../poc/media.mjs';
import { requestHttps } from './https.mjs';

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const MAX_BYTES = 50_000_000;
const DOWNLOAD_PATHS = new Map([
  ['downloader.disk.yandex.ru', '/disk/'],
  ['downloader.dst.yandex.ru', '/disk/'],
  ['mds.storage.yandex.net', '/rdisk/'],
]);
const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm' };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class DiskError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function publicLink(link) {
  const value = typeof link === 'string' ? link.trim() : '';
  const match = value.length <= 2048 && !/[\u0000-\u0020\u007f\\]/.test(value) &&
    /^(https:\/\/(?:disk\.yandex\.ru|disk\.yandex\.com|yadi\.sk)\/[di]\/[A-Za-z0-9_-]{1,200})\/?(?:\?[^#]*)?(?:#.*)?$/.exec(value);
  if (!match) throw new DiskError('INVALID_LINK', 'Вставьте публичную HTTPS-ссылку Яндекс Диска на файл.');
  return match[1];
}

function downloadUrl(value, base) {
  const url = typeof value === 'string' && value.length <= 8192 &&
    !/[\u0000-\u0020\u007f\\]/.test(value) && URL.parse(value, base);
  const downloadPath = DOWNLOAD_PATHS.get(url?.hostname);
  if (!downloadPath || url.protocol !== 'https:' ||
      url.username || url.password || url.port || url.hash || !url.pathname.startsWith(downloadPath)) {
    throw new DiskError('UNSAFE_URL', 'Яндекс Диск вернул неподдерживаемый адрес скачивания.');
  }
  return url;
}

async function discard(response) {
  if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
}

function checkStatus(status) {
  if (status === 200) return;
  if ([401, 403, 404, 410].includes(status)) {
    throw new DiskError('UNAVAILABLE', 'Файл недоступен. Проверьте публичную ссылку и разрешение на скачивание.');
  }
  if ([420, 429].includes(status)) {
    throw new DiskError('QUOTA', 'Яндекс Диск временно ограничил скачивание. Попробуйте позже.');
  }
  throw new DiskError('UNEXPECTED_RESPONSE', 'Яндекс Диск вернул неожиданный HTTP-ответ.');
}

async function apiJson(endpoint, link, request, signal) {
  const url = new URL(endpoint);
  url.searchParams.set('public_key', link);
  const response = await request(url, { redirect: 'manual', signal });
  try {
    checkStatus(response.status);
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      throw new DiskError('INVALID_JSON', 'Яндекс Диск вернул некорректный ответ API.');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > 65_536) throw new DiskError('INVALID_JSON', 'Ответ API Яндекс Диска слишком большой.');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DiskError('INVALID_JSON', 'Яндекс Диск вернул некорректный JSON.');
    }
  } finally {
    await discard(response);
  }
}

function metadataFor(record) {
  if (record?.type === 'dir') throw new DiskError('FOLDER', 'Поделитесь отдельным видеофайлом, а не папкой.');
  if (record?.type !== 'file' || typeof record.name !== 'string' || !record.name.trim() ||
      !Number.isSafeInteger(record.size) || record.size <= 0) {
    throw new DiskError('INVALID_METADATA', 'Яндекс Диск вернул неполные метаданные файла.');
  }
  const extension = path.extname(record.name).toLowerCase();
  if (!Object.hasOwn(TYPES, extension) || ![TYPES[extension], 'application/octet-stream'].includes(record.mime_type)) {
    throw new DiskError('UNSUPPORTED_FORMAT', 'Выберите видео в формате MP4 или WebM.');
  }
  if (record.size > MAX_BYTES) throw new DiskError('TOO_LARGE', 'Размер видео должен быть не больше 50 000 000 байт.');
  return { name: record.name, bytes: record.size, extension };
}

async function downloadResponse(href, request, signal) {
  let url = downloadUrl(href);
  for (let hops = 0; ; hops++) {
    const response = await request(url, { redirect: 'manual', signal });
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    await discard(response);
    if (hops >= 3 || !location) {
      throw new DiskError('INVALID_REDIRECT', 'Скачивание остановлено из-за перенаправлений Яндекс Диска.');
    }
    url = downloadUrl(location, url);
  }
}

// FFprobe uses the same demuxer for Matroska and WebM. Read the declared EBML DocType.
function isWebm(header) {
  function vint(offset, size) {
    const first = header[offset] ?? 0;
    let width = 1;
    while (width <= 4 && !(first & (0x80 >> (width - 1)))) width++;
    if (width > 4 || offset + width > header.length) throw new Error('Invalid EBML');
    const value = header.readUIntBE(offset, width);
    return { value: size ? value - 2 ** (7 * width) : value, next: offset + width };
  }
  if (!header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
  const root = vint(4, true);
  const end = root.next + root.value;
  for (let offset = root.next; end <= header.length && offset < end;) {
    const id = vint(offset, false);
    const size = vint(id.next, true);
    offset = size.next + size.value;
    if (offset > end) break;
    if (id.value === 0x4282) return header.subarray(size.next, offset).equals(Buffer.from('webm'));
  }
  return false;
}

async function verifyVideo(file, extension, inspect) {
  let media;
  let formatOk;
  try {
    media = await inspect(file);
    const formats = media?.format?.format_name?.split(',') ?? [];
    if (extension === '.mp4') {
      const brand = media.format?.tags?.major_brand?.trim() ?? '';
      formatOk = formats.includes('mp4') && /^(isom|iso[2-9]|mp4[12]|avc1|M4V|dash|MSNV|cmfc|cmfs)$/.test(brand);
    } else if (formats.includes('webm')) {
      const handle = await open(file);
      try {
        const header = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        formatOk = isWebm(header.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new DiskError('FFPROBE_REQUIRED', 'Укажите путь к FFprobe в POC_FFPROBE_PATH.');
    if (error.message === 'PROCESS_TIMEOUT') throw new DiskError('FFPROBE_TIMEOUT', 'FFprobe не успел проверить видео.');
    throw new DiskError('INVALID_VIDEO', 'FFprobe не смог проверить скачанный файл.');
  }
  if (!formatOk) throw new DiskError('INVALID_VIDEO', 'Содержимое файла не соответствует заявленному MP4 или WebM.');
  const duration = Number(media.format.duration);
  if (!(duration > 0 && duration <= 300)) {
    throw new DiskError('INVALID_DURATION', 'Длительность видео должна быть больше нуля и не превышать 5 минут.');
  }
  const streams = Array.isArray(media.streams) ? media.streams : [];
  if (!streams.some(stream => stream.codec_type === 'audio') ||
      !streams.some(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)) {
    throw new DiskError('MISSING_TRACK', 'В файле должны быть видео и аудиодорожка.');
  }
  return duration;
}

export async function downloadYandexVideo({ link, request = requestHttps, inspect = probe, timeoutMs = 60_000 }) {
  const share = publicLink(link);
  const signal = AbortSignal.timeout(timeoutMs);
  let directory;
  let file;
  let response;
  try {
    const metadata = metadataFor(await apiJson(API, share, request, signal));
    const target = await apiJson(API + '/download', share, request, signal);
    if (typeof target?.href !== 'string' || target.method !== 'GET' || target.templated !== false) {
      throw new DiskError('INVALID_DOWNLOAD_LINK', 'Яндекс Диск не вернул готовую ссылку скачивания.');
    }
    response = await downloadResponse(target.href, request, signal);
    checkStatus(response.status);
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.body || ![TYPES[metadata.extension], 'application/octet-stream'].includes(type)) {
      throw new DiskError('INVALID_MEDIA_RESPONSE', 'Яндекс Диск вернул ответ другого типа вместо видео.');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== metadata.bytes)) {
      throw new DiskError('SIZE_MISMATCH', 'Размер ответа не совпадает с метаданными.');
    }

    directory = await mkdtemp(path.join(tmpdir(), 'meeting-yandex-'));
    file = path.join(directory, 'source' + metadata.extension);
    let received = 0;
    const hash = createHash('sha256');
    const count = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > metadata.bytes) {
          return callback(new DiskError('SIZE_MISMATCH', 'Получено больше байтов, чем указано в метаданных.'));
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const handle = await open(file, 'wx');
    await pipeline(Readable.fromWeb(response.body), count, handle.createWriteStream(), { signal });
    if (received !== metadata.bytes) throw new DiskError('SIZE_MISMATCH', 'Скачивание прервалось. Размер файла не совпадает с метаданными.');
    const durationSeconds = await verifyVideo(file, metadata.extension, inspect);
    return { name: metadata.name, bytes: received, durationSeconds, sha256: hash.digest('hex') };
  } catch (error) {
    if (error instanceof DiskError) throw error;
    if (signal.aborted) throw new DiskError('TIMEOUT', 'Яндекс Диск не завершил передачу за отведённое время.');
    if (error.code === 'UNSAFE_DNS') throw new DiskError('UNSAFE_URL', 'Адрес Яндекс Диска не разрешился в публичный IP.');
    throw new DiskError('TRANSFER_FAILED', 'Не удалось получить или записать видео Яндекс Диска.');
  } finally {
    if (response) await discard(response);
    if (file) await rm(file, { force: true });
    if (directory) await rmdir(directory);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error('Использование: node yandex-poc/import.mjs "<публичная ссылка Яндекс Диска>"');
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await downloadYandexVideo({ link: process.argv[2] }), null, 2));
    } catch (error) {
      console.error(error instanceof DiskError ? error.message : 'Не удалось выполнить импорт Яндекс Диска.');
      process.exitCode = 1;
    }
  }
}
