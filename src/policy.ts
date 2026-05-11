export type MonitorStatus = 'up' | 'down' | 'unknown' | 'flapping';

export interface PolicyOptions {
  strictFlapping: boolean;
}

export type PolicyOutcome =
  | { kind: 'healthy'; reason: 'up' | 'flapping_lenient' }
  | { kind: 'unhealthy'; reason: 'down' | 'flapping_strict' | 'unknown_after_retry' }
  | { kind: 'retry'; reason: 'unknown_first_seen' };

export function decide(status: MonitorStatus, opts: PolicyOptions): PolicyOutcome {
  switch (status) {
    case 'up':
      return { kind: 'healthy', reason: 'up' };
    case 'down':
      return { kind: 'unhealthy', reason: 'down' };
    case 'flapping':
      return opts.strictFlapping
        ? { kind: 'unhealthy', reason: 'flapping_strict' }
        : { kind: 'healthy', reason: 'flapping_lenient' };
    case 'unknown':
      return { kind: 'retry', reason: 'unknown_first_seen' };
  }
}

export function decideAfterRetry(status: MonitorStatus, opts: PolicyOptions): PolicyOutcome {
  if (status === 'unknown') {
    return { kind: 'unhealthy', reason: 'unknown_after_retry' };
  }
  return decide(status, opts);
}
