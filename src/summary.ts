import * as core from '@actions/core';
import type { MonitorOutcome } from './main.js';

export async function writeStepSummary(outcomes: MonitorOutcome[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const headers = ['Monitor', 'Status', 'Result', 'Last check', 'Region', 'Detail'];
  const rows = outcomes.map((o) => [
    String(o.id),
    statusBadge(o.observedStatus),
    o.outcome.kind === 'healthy' ? 'pass' : 'fail',
    o.lastCheckAt ?? '—',
    o.region ?? '—',
    truncate(o.detail ?? '', 80),
  ]);

  await core.summary
    .addHeading('assert-healthy', 2)
    .addTable([
      headers.map((h) => ({ data: h, header: true })),
      ...rows.map((row) => row.map((c) => ({ data: c }))),
    ])
    .write();
}

function statusBadge(status: string): string {
  switch (status) {
    case 'up':
      return 'up';
    case 'down':
      return 'down';
    case 'flapping':
      return 'flapping';
    case 'unknown':
      return 'unknown';
    default:
      return status;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
