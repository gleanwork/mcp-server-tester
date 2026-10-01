import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { saveStallScreenshot, xwdToPng } from './stallScreenshot.js';

/** Minimal LSBFirst 32bpp TrueColor ZPixmap XWD with the given pixels. */
function xwd(width: number, height: number, pixels: number[]): Buffer {
  const headerSize = 100 + 4; // header + window name "x\0\0\0"
  const header = Buffer.alloc(headerSize);
  const fields = [
    headerSize,
    7,
    2,
    24,
    width,
    height,
    0,
    0,
    32,
    0,
    32,
    32,
    width * 4,
    4, // visual_class: TrueColor
    0x00ff0000, // red_mask
    0x0000ff00, // green_mask
    0x000000ff, // blue_mask
    8, // bits_per_rgb
    256, // colormap_entries
    0, // ncolors
    width,
    height,
    0,
    0,
  ];
  fields.forEach((value, index) =>
    header.writeUInt32BE(value >>> 0, index * 4)
  );
  header.write('x', 100);
  const body = Buffer.alloc(width * height * 4);
  pixels.forEach((pixel, index) => body.writeUInt32LE(pixel >>> 0, index * 4));
  return Buffer.concat([header, body]);
}

describe('stall screenshot', () => {
  it('converts a 32bpp XWD dump into an RGB PNG', () => {
    const png = xwdToPng(
      xwd(4, 1, [0x00ff0000, 0x0000ff00, 0x000000ff, 0x00ffffff])
    );
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(1);
    const idat = png.indexOf('IDAT');
    const length = png.readUInt32BE(idat - 4);
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
    // Red, green, blue, white: every channel reads its own mask (white stays white).
    expect([...raw]).toEqual([
      0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255,
    ]);
  });

  it('rejects truncated or unsupported dumps', () => {
    expect(() => xwdToPng(Buffer.alloc(10))).toThrow(/truncated/);
    const bad = xwd(1, 1, [0]);
    bad.writeUInt32BE(1, 8); // XYPixmap
    expect(() => xwdToPng(bad)).toThrow(/ZPixmap/);
  });

  it('saves the PNG under the evidence directory and never throws', async () => {
    const evidenceDir = await mkdtemp(join(tmpdir(), 'stall-shot-'));
    try {
      const saved = await saveStallScreenshot({
        evidenceDir,
        caseId: 'e2e/0001',
        display: ':1',
        capture: async () => xwd(1, 1, [0x00123456]),
      });
      expect(saved.path).toMatch(/e2e_0001-stall-.*stall-screenshot\.png$/);
      expect((await readFile(saved.path!)).subarray(1, 4).toString()).toBe(
        'PNG'
      );
      await expect(
        saveStallScreenshot({
          evidenceDir,
          caseId: 'c',
          display: ':1',
          capture: async () => {
            throw new Error('no X server');
          },
        })
      ).resolves.toEqual({ error: 'no X server' });
      await expect(
        saveStallScreenshot({ evidenceDir, caseId: 'c' })
      ).resolves.toEqual({ error: 'DISPLAY is unavailable' });
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });
});
