import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADE_MEMORY,
  formatMemory,
  memoryArg,
  parseDockerInfo,
  parseMemory,
  planContext,
} from './dockerCapacity.js';

const GIB = 1024 ** 3;
/** A 12 GiB, 6 CPU Colima VM, as `docker info` reports it. */
const colima = { memory: 12_513_595_392, cpus: 6 };

describe('Docker context capacity', () => {
  it("reads sizes in Docker's syntax", () => {
    expect(parseMemory('8g')).toBe(8 * GIB);
    expect(parseMemory('1.5G')).toBe(1.5 * GIB);
    expect(parseMemory('512m')).toBe(512 * 1024 ** 2);
    expect(parseMemory('1048576')).toBe(1024 ** 2);
    for (const bad of ['', 'lots', '8gb', '-1g', '0', '8 GiB'])
      expect(parseMemory(bad)).toBeUndefined();
    expect(memoryArg(8 * GIB)).toBe('8192m');
    expect(formatMemory(colima.memory)).toBe('11.7 GiB');
    expect(formatMemory(512 * 1024 ** 2)).toBe('512 MiB');
  });

  it("reads docker info's memory and CPUs, or nothing", () => {
    expect(parseDockerInfo('12513595392 6\n')).toEqual(colima);
    expect(parseDockerInfo('')).toBeUndefined();
    expect(parseDockerInfo('<no value> <no value>')).toBeUndefined();
  });

  it('gives a Cowork container all the context can spare, one at a time', () => {
    const plan = planContext('collect', colima, {});
    expect(plan.slots).toBe(1);
    expect(plan.limits).toEqual({ memory: colima.memory - GIB });
    expect(plan.note).toBe(
      'has 11.7 GiB and 6 CPUs: 1 Cowork container at a time, 10.7 GiB each'
    );
    // Asked for: what was asked, still one at a time.
    expect(
      planContext('collect', colima, { memory: 6 * GIB, cpus: 4 })
    ).toMatchObject({ slots: 1, limits: { memory: 6 * GIB, cpus: 4 } });
    // A small context keeps half for its containers, not less.
    expect(
      planContext('collect', { memory: 1.5 * GIB, cpus: 2 }, {}).limits
    ).toEqual({ memory: 0.75 * GIB });
  });

  it('runs as many grade containers as fit, by memory and, when set, CPUs', () => {
    expect(planContext('grade', colima, {})).toMatchObject({
      // 10.7 GiB spare, 2 GiB each.
      slots: 5,
      limits: { memory: DEFAULT_GRADE_MEMORY },
      note: 'has 11.7 GiB and 6 CPUs: 5 grade containers at a time, 2 GiB each',
    });
    expect(planContext('grade', colima, { memory: 4 * GIB }).slots).toBe(2);
    expect(planContext('grade', colima, { memory: GIB, cpus: 2 }).slots).toBe(
      3
    );
  });

  it('runs one container on a context too small for one, and says so', () => {
    const plan = planContext('grade', colima, { memory: 16 * GIB });
    expect(plan.slots).toBe(1);
    expect(plan.note).toContain('; more memory than it can spare (10.7 GiB)');
    expect(planContext('collect', colima, { memory: 16 * GIB }).note).toContain(
      '; more memory than it can spare (10.7 GiB)'
    );
  });

  it('caps cpus at what the context has, and blames the CPUs, not memory', () => {
    // Docker refuses --cpus above the context's CPU count.
    const plan = planContext('grade', colima, { cpus: 8 });
    expect(plan).toMatchObject({
      slots: 1,
      limits: { memory: DEFAULT_GRADE_MEMORY, cpus: 6 },
    });
    expect(plan.note).toBe(
      'has 11.7 GiB and 6 CPUs: 1 grade container at a time, 2 GiB and 6 CPUs each; 8 CPUs asked for, more than it has'
    );
    expect(planContext('collect', colima, { cpus: 8 }).limits.cpus).toBe(6);
    // Without a known size, MST can't cap it: what was asked goes to Docker.
    expect(planContext('grade', undefined, { cpus: 8 }).limits.cpus).toBe(8);
  });

  it("runs one at a time, unlimited, on a context whose size it can't read", () => {
    expect(planContext('collect', undefined, {})).toEqual({
      limits: {},
      slots: 1,
      note: "has an unknown size (docker info didn't say): 1 Cowork container at a time, no memory limit each",
    });
    expect(planContext('grade', undefined, {})).toMatchObject({
      slots: 1,
      limits: { memory: DEFAULT_GRADE_MEMORY },
    });
  });
});
