import * as core from '@actions/core';
import type { MonitorOutcome } from './main.js';

export async function writeStepSummary(outcomes: MonitorOutcome[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const headers = ['Monitor', 'Status', 'Result', 'Last check', 'Region', 'Detail'];
  const rows = outcomes.map((o) => [
    String(o.id),
    statusBadge(o.observedStatus),
    o.outcome.kind === 'healthy' ? 'pass' : 'fail',
    escapeHtml(o.lastCheckAt ?? '—'),
    escapeHtml(o.region ?? '—'),
    escapeHtml(truncate(o.detail ?? '', 80)),
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

// core.summary.addTable writes cells as raw HTML. Upstream error pages
// (proxies, CDNs, auth gateways) often surface as raw markup in o.detail,
// so escape every server-controlled cell before rendering.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
