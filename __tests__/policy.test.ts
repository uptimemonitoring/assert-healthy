import { describe, expect, it } from 'vitest';
import { decide, decideAfterRetry, type MonitorStatus } from '../src/policy.js';

describe('decide (initial)', () => {
  it('up → healthy', () => {
    expect(decide('up', { strictFlapping: true })).toEqual({ kind: 'healthy', reason: 'up' });
    expect(decide('up', { strictFlapping: false })).toEqual({ kind: 'healthy', reason: 'up' });
  });

  it('down → unhealthy', () => {
    expect(decide('down', { strictFlapping: true })).toEqual({
      kind: 'unhealthy',
      reason: 'down',
    });
    expect(decide('down', { strictFlapping: false })).toEqual({
      kind: 'unhealthy',
      reason: 'down',
    });
  });

  it('flapping with strictFlapping=true → unhealthy', () => {
    expect(decide('flapping', { strictFlapping: true })).toEqual({
      kind: 'unhealthy',
      reason: 'flapping_strict',
    });
  });

  it('flapping with strictFlapping=false → healthy', () => {
    expect(decide('flapping', { strictFlapping: false })).toEqual({
      kind: 'healthy',
      reason: 'flapping_lenient',
    });
  });

  it('unknown → retry on first observation', () => {
    expect(decide('unknown', { strictFlapping: true })).toEqual({
      kind: 'retry',
      reason: 'unknown_first_seen',
    });
    expect(decide('unknown', { strictFlapping: false })).toEqual({
      kind: 'retry',
      reason: 'unknown_first_seen',
    });
  });
});

describe('decideAfterRetry', () => {
  it('still unknown → unhealthy with unknown_after_retry', () => {
    expect(decideAfterRetry('unknown', { strictFlapping: true })).toEqual({
      kind: 'unhealthy',
      reason: 'unknown_after_retry',
    });
  });

  it('flipped to up → healthy', () => {
    expect(decideAfterRetry('up', { strictFlapping: true })).toEqual({
      kind: 'healthy',
      reason: 'up',
    });
  });

  it('flipped to down → unhealthy/down', () => {
    expect(decideAfterRetry('down', { strictFlapping: false })).toEqual({
      kind: 'unhealthy',
      reason: 'down',
    });
  });

  it('flipped to flapping respects strictFlapping', () => {
    expect(decideAfterRetry('flapping', { strictFlapping: true })).toEqual({
      kind: 'unhealthy',
      reason: 'flapping_strict',
    });
    expect(decideAfterRetry('flapping', { strictFlapping: false })).toEqual({
      kind: 'healthy',
      reason: 'flapping_lenient',
    });
  });
});

describe('full status × strict-flapping matrix (initial only)', () => {
  const statuses: MonitorStatus[] = ['up', 'down', 'flapping', 'unknown'];
  for (const status of statuses) {
    for (const strict of [true, false]) {
      it(`status=${status} strict=${strict}`, () => {
        const outcome = decide(status, { strictFlapping: strict });
        // Sanity: every initial outcome is one of healthy/unhealthy/retry
        expect(['healthy', 'unhealthy', 'retry']).toContain(outcome.kind);
      });
    }
  }
});
