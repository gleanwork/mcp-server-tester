import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { xwdToPng } from './xwdPng.js';

/** A minimal TrueColor ZPixmap X window dump, as `xwd -root` writes it. */
function xwd(
  width: number,
  height: number,
  pixels: number[],
  { byteOrder = 0, bits = 32 } = {}
): Buffer {
  const step = bits / 8;
  const fields = [
    100 + 4,
    7,
    2,
    24,
    width,
    height,
    0,
    byteOrder,
    32,
    0,
    32,
    bits,
    width * step,
    4,
    0xff0000,
    0x00ff00,
    0x0000ff,
    8,
    256,
    0,
    width,
    height,
    0,
    0,
    0,
  ];
  const header = Buffer.alloc(fields.length * 4);
  fields.forEach((value, index) => header.writeUInt32BE(value, index * 4));
  const body = Buffer.alloc(pixels.length * step);
  pixels.forEach((value, index) =>
    byteOrder === 0
      ? body.writeUIntLE(value, index * step, step)
      : body.writeUIntBE(value, index * step, step)
  );
  return Buffer.concat([header, Buffer.from('root'), body]);
}

/** The RGB rows of an 8-bit, colour-type-2, unfiltered PNG. */
function pngPixels(png: Buffer): number[][] {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  let position = 8;
  let width = 0;
  const data: Buffer[] = [];
  while (position < png.length) {
    const length = png.readUInt32BE(position);
    const kind = png.toString('latin1', position + 4, position + 8);
    const body = png.subarray(position + 8, position + 8 + length);
    if (kind === 'IHDR') width = body.readUInt32BE(0);
    if (kind === 'IDAT') data.push(body);
    position += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = 1 + width * 3;
  const rows: number[][] = [];
  for (let row = 0; row < raw.length; row += stride)
    rows.push([...raw.subarray(row + 1, row + stride)]);
  return rows;
}

describe('xwdToPng', () => {
  it('keeps the pixels of a screen dump in either byte order', () => {
    for (const byteOrder of [0, 1])
      expect(
        pngPixels(
          xwdToPng(
            xwd(2, 2, [0xff0000, 0x00ff00, 0x0000ff, 0x102030], { byteOrder })
          )
        )
      ).toEqual([
        [255, 0, 0, 0, 255, 0],
        [0, 0, 255, 16, 32, 48],
      ]);
  });

  it('refuses a dump in an unsupported format', () => {
    const dump = xwd(1, 1, [0]);
    dump.writeUInt32BE(1, 8); // XYPixmap
    expect(() => xwdToPng(dump)).toThrow();
  });
});
