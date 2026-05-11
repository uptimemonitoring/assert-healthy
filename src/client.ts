import { HttpClient, HttpClientResponse } from '@actions/http-client';
import { BearerCredentialHandler } from '@actions/http-client/lib/auth.js';
import type { MonitorStatus } from './policy.js';

export const API_BASE_URL = 'https://api.uptimemonitoring.com';
export const USER_AGENT = 'uptimemonitoring-assert-healthy';

const KNOWN_STATUSES: readonly string[] = ['up', 'down', 'unknown', 'flapping'];

export interface MonitorDetail {
  monitor: { id: number; url?: string; type?: string };
  state: {
    status: MonitorStatus;
    last_check_at: string | null;
    primary_region?: string;
    evidence_buffer?: Array<{
      timestamp: string;
      region: string;
      status: string;
      http_status?: number;
      latency_ms?: number;
      error?: string;
    }>;
  };
}

export type FetchResult =
  | { kind: 'ok'; detail: MonitorDetail }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'transport_error'; message: string }
  | { kind: 'protocol_error'; message: string };

export interface Fetcher {
  getMonitor(monitorId: number): Promise<FetchResult>;
}

export interface FetcherOptions {
  apiKey: string;
  baseUrl?: string;
  retryOn5xx?: boolean;
}

// Downstream code (outcomeFromDetail, writeStepSummary) trusts the shape of
// MonitorDetail at runtime. Validate every field we read before returning ok,
// so a schema-drifted 200 body surfaces as protocol_error instead of crashing
// later with a TypeError.
function validateMonitorDetail(
  parsed: unknown,
): { kind: 'ok'; detail: MonitorDetail } | { kind: 'protocol_error'; message: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'protocol_error', message: 'response body is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.state || typeof obj.state !== 'object') {
    return { kind: 'protocol_error', message: 'response missing state.status' };
  }
  const stateObj = obj.state as Record<string, unknown>;
  if (typeof stateObj.status !== 'string') {
    return { kind: 'protocol_error', message: 'response missing state.status' };
  }
  if (!KNOWN_STATUSES.includes(stateObj.status)) {
    return {
      kind: 'protocol_error',
      message: `unexpected state.status from API: ${stateObj.status}`,
    };
  }
  if (stateObj.last_check_at !== null && typeof stateObj.last_check_at !== 'string') {
    return {
      kind: 'protocol_error',
      message: 'state.last_check_at must be string or null',
    };
  }
  if (stateObj.primary_region !== undefined && typeof stateObj.primary_region !== 'string') {
    return {
      kind: 'protocol_error',
      message: 'state.primary_region must be a string',
    };
  }
  if (stateObj.evidence_buffer !== undefined && !Array.isArray(stateObj.evidence_buffer)) {
    return {
      kind: 'protocol_error',
      message: 'state.evidence_buffer must be an array',
    };
  }
  return { kind: 'ok', detail: parsed as MonitorDetail };
}

export function createFetcher(opts: FetcherOptions): Fetcher {
  const baseUrl = (opts.baseUrl ?? API_BASE_URL).replace(/\/+$/, '');
  const auth = new BearerCredentialHandler(opts.apiKey);
  const retryOn5xx = opts.retryOn5xx ?? true;
  // Disable implicit redirect following: @actions/http-client drops the
  // Authorization header on cross-host hops, so a future CDN/API-host
  // migration that returned a 30x to a different hostname would silently
  // strip the bearer token and produce a misleading 401. We surface the
  // redirect status as an http_error instead.
  const client = new HttpClient(USER_AGENT, [auth], { allowRedirects: false });

  async function fetchOnce(url: string): Promise<FetchResult> {
    let response: HttpClientResponse;
    try {
      response = await client.get(url, {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'transport_error', message };
    }

    const status = response.message.statusCode ?? 0;
    let body: string;
    try {
      body = await response.readBody();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'transport_error', message: `body read failed: ${message}` };
    }

    if (status >= 200 && status < 300) {
      try {
        const parsed = JSON.parse(body) as unknown;
        const validation = validateMonitorDetail(parsed);
        if (validation.kind === 'protocol_error') return validation;
        return { kind: 'ok', detail: validation.detail };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'protocol_error', message: `invalid JSON: ${message}` };
      }
    }
    return { kind: 'http_error', status, body };
  }

  return {
    async getMonitor(monitorId: number): Promise<FetchResult> {
      const url = `${baseUrl}/api/v1/monitors/${monitorId}`;
      const first = await fetchOnce(url);
      if (!retryOn5xx) return first;
      const isRetryable =
        (first.kind === 'http_error' && first.status >= 500 && first.status < 600) ||
        first.kind === 'transport_error';
      if (!isRetryable) return first;
      const second = await fetchOnce(url);
      // If the first attempt was a reachable 5xx and the retry then loses
      // the network, surfacing only the transport_error would let run()
      // misclassify a reachable-but-erroring API as exit 3 (all-transport).
      // Prefer the original http_error verdict in that case.
      if (first.kind === 'http_error' && second.kind === 'transport_error') {
        return first;
      }
      return second;
    },
  };
}
