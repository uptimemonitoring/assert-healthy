import * as core from '@actions/core';
import { readInputs, InputError } from './inputs.js';
import { createFetcher, type Fetcher, type FetchResult, type MonitorDetail } from './client.js';
import { decide, decideAfterRetry, type MonitorStatus, type PolicyOutcome } from './policy.js';
import { writeStepSummary } from './summary.js';

export const EXIT_INPUT = 2;
export const EXIT_TRANSPORT = 3;

export interface MonitorOutcome {
  id: number;
  observedStatus: MonitorStatus | 'error';
  outcome: PolicyOutcome | { kind: 'unhealthy'; reason: 'http_error' | 'transport_error' };
  lastCheckAt: string | null;
  region: string | null;
  detail: string;
}

export interface RunDeps {
  fetcher: Fetcher;
  sleep: (ms: number) => Promise<void>;
}

export async function evaluateMonitor(
  id: number,
  deps: RunDeps,
  opts: { strictFlapping: boolean; unknownRetryDelayMs: number },
): Promise<MonitorOutcome> {
  const first = await deps.fetcher.getMonitor(id);
  if (first.kind !== 'ok') {
    return errorOutcome(id, first);
  }
  const initial = decide(first.detail.state.status, opts);
  if (initial.kind !== 'retry') {
    return outcomeFromDetail(id, first.detail, initial);
  }
  if (opts.unknownRetryDelayMs > 0) {
    await deps.sleep(opts.unknownRetryDelayMs);
  }
  const second = await deps.fetcher.getMonitor(id);
  if (second.kind !== 'ok') {
    return errorOutcome(id, second);
  }
  const final = decideAfterRetry(second.detail.state.status, opts);
  return outcomeFromDetail(id, second.detail, final);
}

function outcomeFromDetail(
  id: number,
  detail: MonitorDetail,
  outcome: PolicyOutcome,
): MonitorOutcome {
  const lastEvidence = detail.state.evidence_buffer?.slice(-1)[0];
  const detailLine = lastEvidence ? formatEvidence(lastEvidence) : reasonHumanReadable(outcome);
  return {
    id,
    observedStatus: detail.state.status,
    outcome,
    lastCheckAt: detail.state.last_check_at,
    region: detail.state.primary_region ?? null,
    detail: detailLine,
  };
}

function errorOutcome(id: number, result: Exclude<FetchResult, { kind: 'ok' }>): MonitorOutcome {
  if (result.kind === 'http_error') {
    return {
      id,
      observedStatus: 'error',
      outcome: { kind: 'unhealthy', reason: 'http_error' },
      lastCheckAt: null,
      region: null,
      detail: `HTTP ${result.status}: ${truncateBody(result.body)}`,
    };
  }
  return {
    id,
    observedStatus: 'error',
    outcome: { kind: 'unhealthy', reason: 'transport_error' },
    lastCheckAt: null,
    region: null,
    detail: result.message,
  };
}

function formatEvidence(
  ev: NonNullable<MonitorDetail['state']['evidence_buffer']>[number],
): string {
  const parts: string[] = [];
  if (ev.region) parts.push(ev.region);
  if (typeof ev.http_status === 'number') parts.push(`HTTP ${ev.http_status}`);
  if (typeof ev.latency_ms === 'number') parts.push(`${ev.latency_ms}ms`);
  if (ev.error) parts.push(ev.error);
  return parts.join(' · ');
}

function reasonHumanReadable(outcome: PolicyOutcome): string {
  if (outcome.kind === 'healthy') return outcome.reason === 'up' ? 'up' : 'flapping (lenient)';
  if (outcome.kind === 'unhealthy') {
    if (outcome.reason === 'down') return 'down';
    if (outcome.reason === 'flapping_strict') return 'flapping (strict)';
    return 'unknown after retry';
  }
  return 'pending retry';
}

function truncateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 199)}…`;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function run(depsOverride?: Partial<RunDeps>): Promise<void> {
  let inputs: ReturnType<typeof readInputs>;
  try {
    inputs = readInputs();
  } catch (err) {
    if (err instanceof InputError) {
      core.setFailed(err.message);
      process.exitCode = EXIT_INPUT;
      return;
    }
    throw err;
  }

  const fetcher = depsOverride?.fetcher ?? createFetcher({ apiKey: inputs.apiKey });
  const sleep = depsOverride?.sleep ?? defaultSleep;
  const deps: RunDeps = { fetcher, sleep };

  const outcomes: MonitorOutcome[] = [];
  for (const id of inputs.monitorIds) {
    core.info(`Evaluating monitor ${id}…`);
    const outcome = await evaluateMonitor(id, deps, {
      strictFlapping: inputs.strictFlapping,
      unknownRetryDelayMs: inputs.unknownRetryDelayMs,
    });
    outcomes.push(outcome);
    logOutcome(outcome);
  }

  const unhealthy = outcomes.filter((o) => o.outcome.kind === 'unhealthy');
  core.setOutput('unhealthy-count', String(unhealthy.length));
  core.setOutput('unhealthy-ids', unhealthy.map((o) => o.id).join(','));

  await writeStepSummary(outcomes);

  if (unhealthy.length > 0) {
    const transportOnly = unhealthy.every(
      (o) => o.outcome.kind === 'unhealthy' && o.outcome.reason === 'transport_error',
    );
    const summaryLine = `${unhealthy.length} of ${outcomes.length} monitor${outcomes.length === 1 ? '' : 's'} unhealthy.`;
    core.setFailed(summaryLine);
    if (transportOnly) {
      process.exitCode = EXIT_TRANSPORT;
    }
    return;
  }

  core.info(`All ${outcomes.length} monitor${outcomes.length === 1 ? '' : 's'} healthy.`);
}

function logOutcome(o: MonitorOutcome): void {
  const detail = o.detail ? ` — ${o.detail}` : '';
  const lastSeen = o.lastCheckAt ? ` (last check ${o.lastCheckAt})` : '';
  if (o.outcome.kind === 'healthy') {
    core.info(`PASS monitor ${o.id} — ${o.observedStatus}${lastSeen}${detail}`);
    return;
  }
  core.error(`FAIL monitor ${o.id} — ${o.observedStatus}${lastSeen}${detail}`);
}

/* v8 ignore start */
if (process.env.VITEST !== 'true') {
  await run();
}
/* v8 ignore stop */
