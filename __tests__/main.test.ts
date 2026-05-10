import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { evaluateMonitor, run } from '../src/main.js';
import type { Fetcher, FetchResult, MonitorDetail } from '../src/client.js';
import type { MonitorStatus } from '../src/policy.js';

function detail(status: MonitorStatus, opts: Partial<MonitorDetail['state']> = {}): MonitorDetail {
  return {
    monitor: { id: 1, url: 'https://example.com', type: 'http' },
    state: {
      status,
      last_check_at: opts.last_check_at ?? '2026-05-10T20:00:00Z',
      primary_region: opts.primary_region ?? 'EU',
      evidence_buffer: opts.evidence_buffer ?? [],
    },
  };
}

function ok(d: MonitorDetail): FetchResult {
  return { kind: 'ok', detail: d };
}

function makeFetcher(responses: Record<number, FetchResult[]>): {
  fetcher: Fetcher;
  calls: number[];
} {
  const cursor: Record<number, number> = {};
  const calls: number[] = [];
  const fetcher: Fetcher = {
    async getMonitor(id: number): Promise<FetchResult> {
      calls.push(id);
      const list = responses[id];
      if (!list || list.length === 0) {
        throw new Error(`no mock response set up for monitor ${id}`);
      }
      const idx = cursor[id] ?? 0;
      const r = list[Math.min(idx, list.length - 1)];
      cursor[id] = idx + 1;
      return r;
    },
  };
  return { fetcher, calls };
}

describe('evaluateMonitor', () => {
  it('up → healthy, no retry', async () => {
    const { fetcher, calls } = makeFetcher({ 1: [ok(detail('up'))] });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome.kind).toBe('healthy');
    expect(calls).toEqual([1]);
  });

  it('down → unhealthy, no retry', async () => {
    const { fetcher } = makeFetcher({
      2: [
        ok(
          detail('down', {
            evidence_buffer: [
              {
                timestamp: 't',
                region: 'EU',
                status: 'down',
                http_status: 503,
                error: 'connection refused',
              },
            ],
          }),
        ),
      ],
    });
    const out = await evaluateMonitor(
      2,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'down' });
    expect(out.detail).toContain('503');
  });

  it('flapping × strict=true → unhealthy', async () => {
    const { fetcher } = makeFetcher({ 3: [ok(detail('flapping'))] });
    const out = await evaluateMonitor(
      3,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'flapping_strict' });
  });

  it('flapping × strict=false → healthy', async () => {
    const { fetcher } = makeFetcher({ 3: [ok(detail('flapping'))] });
    const out = await evaluateMonitor(
      3,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: false, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome).toEqual({ kind: 'healthy', reason: 'flapping_lenient' });
  });

  it('unknown → retry then up = healthy', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { fetcher, calls } = makeFetcher({ 4: [ok(detail('unknown')), ok(detail('up'))] });
    const out = await evaluateMonitor(
      4,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 1234 },
    );
    expect(out.outcome).toEqual({ kind: 'healthy', reason: 'up' });
    expect(calls).toEqual([4, 4]);
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it('unknown → retry still unknown = unhealthy', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { fetcher } = makeFetcher({ 5: [ok(detail('unknown')), ok(detail('unknown'))] });
    const out = await evaluateMonitor(
      5,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 1 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'unknown_after_retry' });
  });

  it('unknown with delay 0 skips sleep', async () => {
    const sleep = vi.fn();
    const { fetcher } = makeFetcher({ 6: [ok(detail('unknown')), ok(detail('up'))] });
    await evaluateMonitor(6, { fetcher, sleep }, { strictFlapping: true, unknownRetryDelayMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('http_error → unhealthy/http_error with status in detail', async () => {
    const { fetcher } = makeFetcher({
      7: [{ kind: 'http_error', status: 401, body: '{"error":"unauthorized"}' }],
    });
    const out = await evaluateMonitor(
      7,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'http_error' });
    expect(out.detail).toContain('401');
  });

  it('transport_error → unhealthy/transport_error', async () => {
    const { fetcher } = makeFetcher({
      8: [{ kind: 'transport_error', message: 'ECONNREFUSED' }],
    });
    const out = await evaluateMonitor(
      8,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'transport_error' });
    expect(out.detail).toBe('ECONNREFUSED');
  });
});

describe('run (multi-monitor fan-out)', () => {
  const apiKey = 'umk_test_abcdef0123456789';
  let originalEnv: NodeJS.ProcessEnv;
  let setFailed: ReturnType<typeof vi.spyOn>;
  let setOutput: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.GITHUB_STEP_SUMMARY = '';
    process.env['INPUT_API-KEY'] = apiKey;
    process.exitCode = 0;
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => undefined);
    setOutput = vi.spyOn(core, 'setOutput').mockImplementation(() => undefined);
    vi.spyOn(core, 'info').mockImplementation(() => undefined);
    vi.spyOn(core, 'error').mockImplementation(() => undefined);
    vi.spyOn(core, 'setSecret').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('all healthy → no failure, exit 0, outputs zeroed', async () => {
    process.env['INPUT_MONITOR-IDS'] = '111,222';
    process.env['INPUT_STRICT-FLAPPING'] = 'true';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      111: [ok(detail('up'))],
      222: [ok(detail('up'))],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setFailed).not.toHaveBeenCalled();
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '0');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '');
    expect(setOutput).toHaveBeenCalledWith('down-ids', '');
    expect(process.exitCode).toBe(0);
  });

  it('down-ids includes only confirmed-down monitors, excludes http_error', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2,3';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [ok(detail('down'))], // real down
      2: [{ kind: 'http_error', status: 401, body: '{"error":"x"}' }], // API error
      3: [ok(detail('up'))], // healthy
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '2');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '1,2');
    expect(setOutput).toHaveBeenCalledWith('down-ids', '1');
  });

  it('one down out of two → failure with ID list', async () => {
    process.env['INPUT_MONITOR-IDS'] = '111\n222';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      111: [ok(detail('up'))],
      222: [ok(detail('down'))],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '1');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '222');
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('1 of 2 monitors unhealthy'));
  });

  it('all down → failure', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [ok(detail('down'))],
      2: [ok(detail('down'))],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '2');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '1,2');
    expect(process.exitCode).not.toBe(3);
  });

  it('all transport errors → exit code 3', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [{ kind: 'transport_error', message: 'ECONNRESET' }],
      2: [{ kind: 'transport_error', message: 'ETIMEDOUT' }],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(process.exitCode).toBe(3);
  });

  it('one healthy + one transport error does NOT collapse to exit 3', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [ok(detail('up'))],
      2: [{ kind: 'transport_error', message: 'ECONNRESET' }],
    });
    await run({ fetcher, sleep: vi.fn() });
    // We got a verdict for monitor 1 (healthy), so the run is "regular unhealthy".
    expect(process.exitCode).not.toBe(3);
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '1');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '2');
  });

  it('invalid api-key → exit code 2', async () => {
    process.env['INPUT_API-KEY'] = 'not-a-key';
    process.env['INPUT_MONITOR-IDS'] = '1';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    await run();
    expect(process.exitCode).toBe(2);
    expect(setFailed).toHaveBeenCalled();
    const failArg = String(setFailed.mock.calls[0]?.[0] ?? '');
    expect(failArg).not.toContain('not-a-key');
  });

  it('error message does not echo the api key', async () => {
    process.env['INPUT_MONITOR-IDS'] = ''; // empty → triggers InputError
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    await run();
    for (const call of setFailed.mock.calls) {
      expect(String(call[0])).not.toContain(apiKey);
    }
  });
});
