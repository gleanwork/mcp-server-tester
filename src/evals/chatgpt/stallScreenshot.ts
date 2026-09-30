import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** A turn whose transcript has not grown for this long is treated as stalled. */
export const CHATGPT_STALL_MS = 120_000;
const CAPTURE_TIMEOUT_MS = 10_000;
// A 4K 32bpp root window is ~33 MB; anything larger is not a screen dump.
const MAX_XWD_BYTES = 64 * 1024 * 1024;

export interface StallScreenshot {
  path?: string;
  error?: string;
}

/** Run `xwd -root` on the eval display and return the raw XWD dump. */
function captureXwd(display: string, xauthority?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      DISPLAY: display,
    };
    if (xauthority) env.XAUTHORITY = xauthority;
    const child = spawn('xwd', ['-root', '-silent'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('xwd timed out'));
    }, CAPTURE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_XWD_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (size > MAX_XWD_BYTES) reject(new Error('xwd output too large'));
      else if (code !== 0) reject(new Error(`xwd exited ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Convert a 24/32-bit TrueColor ZPixmap XWD dump into an RGB PNG. */
export function xwdToPng(xwd: Buffer): Buffer {
  if (xwd.length < 100) throw new Error('XWD header is truncated');
  const header = (index: number) => xwd.readUInt32BE(index * 4);
  const headerSize = header(0);
  const format = header(2);
  const width = header(4);
  const height = header(5);
  const byteOrder = header(7); // 0 = LSBFirst
  const bitsPerPixel = header(11);
  const bytesPerLine = header(12);
  const [redMask, greenMask, blueMask] = [header(15), header(16), header(17)];
  const colormapEntries = header(19);
  if (format !== 2) throw new Error('XWD is not ZPixmap');
  if (bitsPerPixel !== 32 && bitsPerPixel !== 24)
    throw new Error(`Unsupported XWD depth ${bitsPerPixel}`);
  if (!width || !height || width > 16384 || height > 16384)
    throw new Error('XWD dimensions are invalid');
  const offset = headerSize + colormapEntries * 12;
  if (offset + bytesPerLine * height > xwd.length)
    throw new Error('XWD pixel data is truncated');
  const shift = (mask: number) => {
    let bits = 0;
    while (mask && !((mask >>> bits) & 1)) bits++;
    return bits;
  };
  const shifts = [shift(redMask), shift(greenMask), shift(blueMask)];
  const masks = [redMask, greenMask, blueMask];
  const step = bitsPerPixel / 8;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = offset + y * bytesPerLine;
    const out = y * (width * 3 + 1);
    raw[out] = 0; // PNG filter: none
    for (let x = 0; x < width; x++) {
      const at = row + x * step;
      let pixel = 0;
      for (let b = 0; b < step; b++) {
        const byte = xwd[at + b]!;
        pixel =
          byteOrder === 0 ? pixel | (byte << (8 * b)) : (pixel << 8) | byte;
      }
      pixel >>>= 0;
      for (let c = 0; c < 3; c++)
        raw[out + 1 + x * 3 + c] = ((pixel & masks[c]!) >>> shifts[c]!) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Save a PNG of the eval display into the evidence directory. Never throws:
 * a failed capture must not change the case outcome, only its diagnostics.
 */
export async function saveStallScreenshot(options: {
  evidenceDir: string;
  caseId: string;
  display?: string;
  xauthority?: string;
  capture?: (display: string, xauthority?: string) => Promise<Buffer>;
}): Promise<StallScreenshot> {
  if (!options.display) return { error: 'DISPLAY is unavailable' };
  try {
    const xwd = await (options.capture ?? captureXwd)(
      options.display,
      options.xauthority
    );
    const slug = options.caseId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
    const directory = await mkdtemp(
      join(options.evidenceDir, `${slug || 'case'}-stall-`)
    );
    const path = join(directory, 'stall-screenshot.png');
    await writeFile(path, xwdToPng(xwd), { mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
