import * as core from '@actions/core';

export interface ActionInputs {
  apiKey: string;
  monitorIds: number[];
  strictFlapping: boolean;
  unknownRetryDelayMs: number;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const API_KEY_PATTERN = /^umk_(live|test)_[A-Za-z0-9]+$/;

export function parseMonitorIds(raw: string): number[] {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new InputError('monitor-ids is required and must contain at least one ID');
  }
  const ids: number[] = [];
  for (const t of tokens) {
    if (!/^[1-9][0-9]*$/.test(t)) {
      throw new InputError(`monitor-ids contains a non-numeric value: "${t}"`);
    }
    const id = Number(t);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new InputError(`monitor-ids contains an invalid ID: "${t}"`);
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function parseBoolean(raw: string, name: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new InputError(`${name} must be "true" or "false" (got "${raw}")`);
}

export function parsePositiveSeconds(raw: string, name: string): number {
  const v = raw.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(v)) {
    throw new InputError(`${name} must be a non-negative number (got "${raw}")`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new InputError(`${name} must be a non-negative number (got "${raw}")`);
  }
  if (n > 600) {
    throw new InputError(`${name} must be at most 600 seconds (got ${n})`);
  }
  return Math.round(n * 1000);
}

export function readInputs(): ActionInputs {
  const apiKey = core.getInput('api-key').trim();
  if (apiKey.length === 0) {
    throw new InputError('api-key is required');
  }
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new InputError('api-key must match the pattern "umk_live_<token>" or "umk_test_<token>"');
  }
  core.setSecret(apiKey);

  const monitorIds = parseMonitorIds(core.getInput('monitor-ids'));
  const strictFlapping = parseBoolean(
    core.getInput('strict-flapping') || 'true',
    'strict-flapping',
  );
  const unknownRetryDelayMs = parsePositiveSeconds(
    core.getInput('unknown-retry-delay-seconds') || '10',
    'unknown-retry-delay-seconds',
  );

  return { apiKey, monitorIds, strictFlapping, unknownRetryDelayMs };
}
