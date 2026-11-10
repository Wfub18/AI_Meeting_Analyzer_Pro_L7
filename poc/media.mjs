import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function binaries() {
  // Use existing local tools; no installation, download, or API call at runtime.
  const defaults = process.platform === 'win32'
    ? ['C:/Program Files/Shutter Encoder/app/Library/ffmpeg.exe', 'C:/Program Files/Shutter Encoder/app/Library/ffprobe.exe']
    : [path.join(here, 'bin/ffmpeg'), path.join(here, 'bin/ffprobe')];
  return { ffmpeg: process.env.POC_FFMPEG_PATH || defaults[0], ffprobe: process.env.POC_FFPROBE_PATH || defaults[1] };
}

export function run(binary, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(binary, args, { shell: false, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-128_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('PROCESS_TIMEOUT'));
      if (code !== 0) return reject(new Error(`MEDIA_PROCESS_FAILED (${code}): ${stderr.slice(-2000)}`));
      resolve({ stdout, stderr, milliseconds: Math.round(performance.now() - start) });
    });
  });
}

export async function probe(file, tools = binaries()) {
  const result = await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'mov,matroska,webm,mp3,wav', '-show_format', '-show_streams', '-of', 'json', file]);
  return JSON.parse(result.stdout);
}

export async function checkContainer(file, extension, format) {
  const formats = format?.format_name?.split(',') ?? [];
  if (extension === '.mp4') {
    const brand = format?.tags?.major_brand?.trim();
    if (formats.includes('mp4') &&
        /^(isom|iso[2-9]|mp4[12]|avc1|M4V|dash|MSNV|cmfc|cmfs)$/.test(brand ?? '')) return;
    throw new Error('UNSUPPORTED_CONTAINER');
  }
  if (extension !== '.webm' || !formats.includes('webm')) throw new Error('UNSUPPORTED_CONTAINER');

  const handle = await open(file);
  const buffer = Buffer.alloc(4096);
  let size;
  try {
    ({ bytesRead: size } = await handle.read(buffer));
  } finally {
    await handle.close();
  }
  const header = buffer.subarray(0, size);
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    // Read the EBML header's declared DocType. FFprobe uses one demuxer for MKV and WebM.
    function readVint(offset, isSize) {
      const first = header[offset] ?? 0;
      let width = 1;
      while (width <= 4 && !(first & (0x80 >> (width - 1)))) width++;
      if (width > 4 || offset + width > header.length) throw new Error('UNSUPPORTED_CONTAINER');
      const raw = header.readUIntBE(offset, width);
      return { value: isSize ? raw - 2 ** (7 * width) : raw, next: offset + width };
    }
    const root = readVint(4, true);
    const end = root.next + root.value;
    for (let offset = root.next; end <= header.length && offset < end;) {
      const id = readVint(offset, false);
      const length = readVint(id.next, true);
      offset = length.next + length.value;
      if (offset > end) break;
      if (id.value === 0x4282 && header.toString('ascii', length.next, offset) === 'webm') return;
    }
  }
  throw new Error('UNSUPPORTED_CONTAINER');
}

export async function validateVideo(file, tools = binaries()) {
  if (!['.mp4', '.webm'].includes(path.extname(file).toLowerCase())) throw new Error('UNSUPPORTED_EXTENSION');
  const size = (await stat(file)).size;
  if (!size || size > 50_000_000) throw new Error('INVALID_VIDEO_SIZE');
  const metadata = await probe(file, tools);
  if (!metadata.format.format_name.split(',').some(x => ['mp4', 'mov', 'webm', 'matroska'].includes(x))) {
    throw new Error('UNSUPPORTED_CONTAINER');
  }
  const audio = metadata.streams.find(x => x.codec_type === 'audio');
  if (!audio) throw new Error('NO_AUDIO_TRACK');
  const duration = Number(metadata.format.duration);
  // Small tolerance for container/codec padding. No silent truncation.
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300.25) throw new Error('INVALID_DURATION');
  return { size, duration, audioCodec: audio.codec_name, hasVideo: metadata.streams.some(x => x.codec_type === 'video') };
}

export async function extract(file, output, mode, tools = binaries()) {
  const input = await validateVideo(file, tools);
  let codec;
  if (mode === 'copy') codec = ['-c:a', 'copy'];
  else if (mode === 'mp3') codec = ['-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-ar', '16000'];
  else if (mode === 'wav') codec = ['-c:a', 'pcm_s16le', '-ac', '1', '-ar', '16000'];
  else throw new Error('UNKNOWN_MODE');
  const result = await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', ...codec, output]);
  const size = (await stat(output)).size;
  if (!size || size > 24_000_000) throw new Error('INVALID_AUDIO_SIZE');
  const metadata = await probe(output, tools);
  if (metadata.streams.some(x => x.codec_type === 'video')) throw new Error('VIDEO_NOT_REMOVED');
  if (!metadata.streams.some(x => x.codec_type === 'audio')) throw new Error('EMPTY_AUDIO_OUTPUT');
  // Actually decode the entire output, instead of treating readable headers as proof.
  await run(tools.ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
    '-i', output, '-map', '0:a:0', '-f', 'null', '-']);
  return { mode, bytes: size, milliseconds: result.milliseconds, duration: Number(metadata.format.duration),
    codec: metadata.streams.find(x => x.codec_type === 'audio').codec_name, sourceCodec: input.audioCodec };
}
