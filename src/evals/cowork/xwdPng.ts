import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(kind, 'ascii'), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, tail]);
}

/** The index of a mask's lowest set bit. */
function shift(mask: number): number {
  if (mask === 0) return 0;
  let offset = 0;
  while (((mask >>> offset) & 1) === 0) offset++;
  return offset;
}

/**
 * A TrueColor X window dump (`xwd`: ZPixmap, 24 or 32 bits per pixel) as an
 * RGB PNG. The dump's header is big-endian; its pixels use its own byte order.
 */
export function xwdToPng(data: Buffer): Buffer {
  if (data.length < 100) throw new Error('unsupported_xwd');
  const field = (index: number) => data.readUInt32BE(index * 4);
  const headerSize = field(0);
  const format = field(2);
  const width = field(4);
  const height = field(5);
  const littleEndian = field(7) === 0;
  const bitsPerPixel = field(11);
  const bytesPerLine = field(12);
  const masks = [field(14), field(15), field(16)];
  const colors = field(19);
  if (format !== 2 || (bitsPerPixel !== 24 && bitsPerPixel !== 32))
    throw new Error('unsupported_xwd');
  const step = bitsPerPixel / 8;
  const start = headerSize + colors * 12;
  if (
    start + height * bytesPerLine > data.length ||
    width * step > bytesPerLine
  )
    throw new Error('unsupported_xwd');
  const channels = masks.map((mask) => [mask, shift(mask)] as const);
  const rows = Buffer.alloc(height * (1 + width * 3));
  let out = 0;
  for (let y = 0; y < height; y++) {
    rows[out++] = 0; // No filter.
    const line = start + y * bytesPerLine;
    for (let x = 0; x < width; x++) {
      const at = line + x * step;
      let value = 0;
      for (let i = 0; i < step; i++) {
        const byte = data[littleEndian ? at + i : at + step - 1 - i]!;
        value += byte * 2 ** (8 * i);
      }
      for (const [mask, offset] of channels)
        rows[out++] = (((value & mask) >>> 0) >>> offset) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
