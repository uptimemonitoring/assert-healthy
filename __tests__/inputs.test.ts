import { describe, expect, it } from 'vitest';
import { parseBoolean, parseMonitorIds, parsePositiveSeconds, InputError } from '../src/inputs.js';

describe('parseMonitorIds', () => {
  it('accepts a single id', () => {
    expect(parseMonitorIds('42')).toEqual([42]);
  });

  it('accepts comma-separated ids', () => {
    expect(parseMonitorIds('1,2,3')).toEqual([1, 2, 3]);
  });

  it('accepts newline-separated ids', () => {
    expect(parseMonitorIds('1\n2\n3')).toEqual([1, 2, 3]);
  });

  it('accepts mixed comma + newline + extra whitespace', () => {
    expect(parseMonitorIds('  1, 2 \n 3,  4 ')).toEqual([1, 2, 3, 4]);
  });

  it('deduplicates while preserving order', () => {
    expect(parseMonitorIds('3,1,2,1,3')).toEqual([3, 1, 2]);
  });

  it('rejects empty input', () => {
    expect(() => parseMonitorIds('')).toThrow(InputError);
    expect(() => parseMonitorIds('   ')).toThrow(InputError);
  });

  it('rejects non-numeric', () => {
    expect(() => parseMonitorIds('abc')).toThrow(InputError);
    expect(() => parseMonitorIds('1,foo,3')).toThrow(InputError);
  });

  it('rejects zero and negatives', () => {
    expect(() => parseMonitorIds('0')).toThrow(InputError);
    expect(() => parseMonitorIds('-5')).toThrow(InputError);
  });

  it('rejects floats', () => {
    expect(() => parseMonitorIds('1.5')).toThrow(InputError);
  });
});

describe('parseBoolean', () => {
  it('accepts true variants', () => {
    expect(parseBoolean('true', 'x')).toBe(true);
    expect(parseBoolean('TRUE', 'x')).toBe(true);
    expect(parseBoolean('1', 'x')).toBe(true);
    expect(parseBoolean('yes', 'x')).toBe(true);
  });

  it('accepts false variants', () => {
    expect(parseBoolean('false', 'x')).toBe(false);
    expect(parseBoolean('FALSE', 'x')).toBe(false);
    expect(parseBoolean('0', 'x')).toBe(false);
    expect(parseBoolean('no', 'x')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(() => parseBoolean('maybe', 'strict-flapping')).toThrow(InputError);
  });
});

describe('parsePositiveSeconds', () => {
  it('returns ms for whole seconds', () => {
    expect(parsePositiveSeconds('10', 'x')).toBe(10_000);
    expect(parsePositiveSeconds('0', 'x')).toBe(0);
  });

  it('accepts fractional seconds', () => {
    expect(parsePositiveSeconds('1.5', 'x')).toBe(1500);
  });

  it('rejects negatives', () => {
    expect(() => parsePositiveSeconds('-1', 'x')).toThrow(InputError);
  });

  it('rejects non-numeric', () => {
    expect(() => parsePositiveSeconds('abc', 'x')).toThrow(InputError);
  });

  it('caps at 600 seconds', () => {
    expect(parsePositiveSeconds('600', 'x')).toBe(600_000);
    expect(() => parsePositiveSeconds('601', 'x')).toThrow(InputError);
  });
});
