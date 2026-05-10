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
  | { kind: 'transport_error'; message: string };

export interface Fetcher {
  getMonitor(monitorId: number): Promise<FetchResult>;
}

export interface FetcherOptions {
  apiKey: string;
  baseUrl?: string;
  retryOn5xx?: boolean;
}

export function createFetcher(opts: FetcherOptions): Fetcher {
  const baseUrl = (opts.baseUrl ?? API_BASE_URL).replace(/\/+$/, '');
  const auth = new BearerCredentialHandler(opts.apiKey);
  const client = new HttpClient(USER_AGENT, [auth], {
    allowRetries: opts.retryOn5xx ?? true,
    maxRetries: opts.retryOn5xx === false ? 0 : 1,
  });

  return {
    async getMonitor(monitorId: number): Promise<FetchResult> {
      const url = `${baseUrl}/api/v1/monitors/${monitorId}`;
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
          const parsed = JSON.parse(body) as MonitorDetail;
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            !parsed.state ||
            typeof parsed.state.status !== 'string'
          ) {
            return {
              kind: 'transport_error',
              message: 'response missing state.status',
            };
          }
          if (!KNOWN_STATUSES.includes(parsed.state.status)) {
            return {
              kind: 'transport_error',
              message: `unexpected state.status from API: ${String(parsed.state.status)}`,
            };
          }
          return { kind: 'ok', detail: parsed };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { kind: 'transport_error', message: `invalid JSON: ${message}` };
        }
      }
      return { kind: 'http_error', status, body };
    },
  };
}
