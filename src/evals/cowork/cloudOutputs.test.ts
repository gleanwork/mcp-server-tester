import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CLOUD_OUTPUT_BYTES,
  cloudOutputName,
  cloudOutputPaths,
  cloudTaskFinished,
  saveCloudOutputs,
  setCloudOutputRetryDelaysForTests,
  type CloudFileRead,
} from './cloudOutputs.js';
import { CoworkCloudControlRequestSchema } from './cloudControlProtocol.js';
import type { CloudSessionEvent } from './claudeAi.js';

const OUT = '/mnt/user-data/outputs/';
const use = (name: string, input: Record<string, unknown>) => ({
  payload: {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
    },
  },
});
const toolResult = (text: string) => ({
  payload: {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: text }],
    },
  },
});
const result = { payload: { type: 'result', subtype: 'success' } };
const base64 = (text: string) => Buffer.from(text).toString('base64');

describe('cloudOutputName', () => {
  it('names files under the outputs folder only', () => {
    expect(cloudOutputName(`${OUT}Q3 report.docx`)).toBe('Q3 report.docx');
    expect(cloudOutputName(`${OUT}charts/a.png`)).toBe('charts/a.png');
    for (const path of [
      OUT,
      `${OUT}charts/`,
      `${OUT}../secrets.txt`,
      `${OUT}a/./b.txt`,
      `${OUT}a//b.txt`,
      `${OUT}a\\b.txt`,
      '/mnt/user-data/uploads/a.txt',
      '/sessions/x/mnt/outputs/a.txt',
      `${OUT}${'a'.repeat(600)}.txt`,
    ])
      expect(cloudOutputName(path)).toBeUndefined();
  });
});

describe('cloudOutputPaths', () => {
  it('takes sent files first, then written ones, then mentions', () => {
    const events: CloudSessionEvent[] = [
      toolResult(
        `Saved ${OUT}orders.xlsx',data_only=True and ${OUT}notes.v2.md.`
      ),
      use('Write', { file_path: `${OUT}evals-lesson.html`, content: '<html>' }),
      use('Write', { file_path: '/tmp/scratch.py', content: '' }),
      use('NotebookEdit', { notebook_path: `${OUT}model.ipynb` }),
      use('SendUserFile', {
        files: [`${OUT}Glean DPA - Section 6 redline.docx`, 7],
      }),
      toolResult(
        `1 file delivered to user.\n  ${OUT}Glean DPA - Section 6 redline.docx → file_uuid: c358`
      ),
      {
        payload: {
          type: 'assistant',
          message: { content: 'Open `' + OUT + 'evals-lesson.html`.' },
        },
      },
    ];
    expect(cloudOutputPaths(events)).toEqual([
      { path: `${OUT}Glean DPA - Section 6 redline.docx`, source: 'sent' },
      { path: `${OUT}evals-lesson.html`, source: 'written' },
      { path: `${OUT}model.ipynb`, source: 'written' },
      { path: `${OUT}orders.xlsx`, source: 'mentioned' },
      { path: `${OUT}notes.v2`, source: 'mentioned' },
      { path: `${OUT}notes.v2.md`, source: 'mentioned' },
    ]);
  });
});

describe('cloudTaskFinished', () => {
  it('is true only when a result follows the last reply', () => {
    expect(cloudTaskFinished([use('Write', {})])).toBe(false);
    expect(cloudTaskFinished([use('Write', {}), result])).toBe(true);
    expect(cloudTaskFinished([result, use('Write', {})])).toBe(false);
    expect(cloudTaskFinished([])).toBe(false);
  });
});

describe('saveCloudOutputs', () => {
  let dir: string;
  let restoreDelays: () => void;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mst-cloud-outputs-'));
    restoreDelays = setCloudOutputRetryDelaysForTests([0, 0]);
  });
  afterEach(async () => {
    restoreDelays();
    await rm(dir, { recursive: true, force: true });
  });
  const manifest = async () =>
    JSON.parse(await readFile(join(dir, 'outputs.json'), 'utf8')) as {
      root: string;
      files: unknown[];
    };

  it('saves what claude.ai serves, records the rest, and drops guesses', async () => {
    const events: CloudSessionEvent[] = [
      use('SendUserFile', { files: [`${OUT}report.docx`, `${OUT}gone.pdf`] }),
      use('Write', { file_path: `${OUT}charts/a.png`, content: '' }),
      use('Write', { file_path: `${OUT}huge.bin`, content: '' }),
      toolResult(`see ${OUT}maybe.txt`),
      result,
    ];
    let flaky = 0;
    const read = async (path: string): Promise<CloudFileRead> => {
      if (path.endsWith('report.docx'))
        return { status: 'saved', content: base64('report') };
      if (path.endsWith('a.png')) {
        if (flaky++ < 2) throw new Error('claude.ai reading failed (502).');
        return { status: 'saved', content: base64('png') };
      }
      if (path.endsWith('huge.bin')) return { status: 'too_large' };
      return { status: 'missing' };
    };
    const records = await saveCloudOutputs(dir, events, read);
    expect(await readFile(join(dir, 'outputs', 'report.docx'), 'utf8')).toBe(
      'report'
    );
    expect(
      await readFile(join(dir, 'outputs', 'charts', 'a.png'), 'utf8')
    ).toBe('png');
    expect(records).toEqual([
      { path: `${OUT}report.docx`, source: 'sent', status: 'saved', bytes: 6 },
      { path: `${OUT}gone.pdf`, source: 'sent', status: 'missing' },
      {
        path: `${OUT}charts/a.png`,
        source: 'written',
        status: 'saved',
        bytes: 3,
      },
      { path: `${OUT}huge.bin`, source: 'written', status: 'too_large' },
    ]);
    expect(await manifest()).toEqual({ root: OUT, files: records });
    expect(await readdir(dir)).toEqual(['outputs', 'outputs.json']);
  });

  it('records a read that keeps failing, without failing the trial', async () => {
    const events = [use('SendUserFile', { files: [`${OUT}a.txt`] }), result];
    let calls = 0;
    const records = await saveCloudOutputs(dir, events, async () => {
      calls++;
      throw new Error('claude.ai reading failed (503).');
    });
    expect(calls).toBe(3);
    expect(records).toEqual([
      {
        path: `${OUT}a.txt`,
        source: 'sent',
        status: 'error',
        error: 'claude.ai reading failed (503).',
      },
    ]);
    expect(await readdir(dir)).toEqual(['outputs.json']);
  });

  it('replaces an earlier copy and refuses a file past the size limit', async () => {
    await mkdir(join(dir, 'outputs'), { recursive: true });
    await writeFile(join(dir, 'outputs', 'stale.txt'), 'old');
    const big = Buffer.alloc(MAX_CLOUD_OUTPUT_BYTES + 1).toString('base64');
    const records = await saveCloudOutputs(
      dir,
      [use('Write', { file_path: `${OUT}big.bin` }), result],
      async () => ({ status: 'saved', content: big })
    );
    expect(records).toEqual([
      {
        path: `${OUT}big.bin`,
        source: 'written',
        status: 'too_large',
        bytes: MAX_CLOUD_OUTPUT_BYTES + 1,
      },
    ]);
    expect(await readdir(dir)).toEqual(['outputs.json']);
  });
});

describe('cloud-control file request', () => {
  const request = (path: string) => ({
    protocol: 'mst.cowork-cloud-control/v1',
    id: 1,
    method: 'file',
    sessionId: 'cse_abc',
    path,
  });
  it('carries only an output file path', () => {
    expect(
      CoworkCloudControlRequestSchema.safeParse(request(`${OUT}a.docx`)).success
    ).toBe(true);
    for (const path of [`${OUT}../x`, '/etc/passwd', OUT])
      expect(
        CoworkCloudControlRequestSchema.safeParse(request(path)).success
      ).toBe(false);
  });
});
