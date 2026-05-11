import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

function makeMockResponse(body: string, statusCode: number) {
  return {
    message: { statusCode },
    readBody: async (): Promise<string> => body,
  };
}

interface MockState {
  lastUrl: string | undefined;
  lastHeaders: Record<string, string> | undefined;
  lastAuthHeader: string | undefined;
  getMock: ReturnType<typeof vi.fn>;
}

function setupMocks(state: MockState): void {
  vi.doMock('@actions/http-client', () => ({
    HttpClient: class {
      private handlers: Array<{
        prepareRequest?: (opts: { headers: Record<string, string> }) => void;
      }>;
      constructor(
        _ua: string,
        handlers: Array<{
          prepareRequest?: (opts: { headers: Record<string, string> }) => void;
        }>,
      ) {
        this.handlers = handlers;
      }
      async get(url: string, headers: Record<string, string>): Promise<unknown> {
        state.lastUrl = url;
        state.lastHeaders = headers;
        const opts = { headers: {} as Record<string, string> };
        for (const h of this.handlers ?? []) {
          h.prepareRequest?.(opts);
        }
        state.lastAuthHeader = opts.headers['Authorization'] ?? opts.headers['authorization'];
        return state.getMock();
      }
    },
  }));
  vi.doMock('@actions/http-client/lib/auth.js', () => ({
    BearerCredentialHandler: class {
      token: string;
      constructor(token: string) {
        this.token = token;
      }
      prepareRequest(opts: { headers: Record<string, string> }): void {
        opts.headers['Authorization'] = `Bearer ${this.token}`;
      }
      canHandleAuthentication(): boolean {
        return false;
      }
      async handleAuthentication(): Promise<unknown> {
        throw new Error('not implemented');
      }
    },
  }));
}

describe('createFetcher.getMonitor', () => {
  let state: MockState;

  beforeEach(() => {
    state = {
      lastUrl: undefined,
      lastHeaders: undefined,
      lastAuthHeader: undefined,
      getMock: vi.fn(),
    };
    vi.resetModules();
    setupMocks(state);
  });

  afterEach(() => {
    vi.unmock('@actions/http-client');
    vi.unmock('@actions/http-client/lib/auth.js');
    vi.resetModules();
  });

  it('hits the canonical URL with bearer + user-agent', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 42 },
          state: { status: 'up', last_check_at: 't', primary_region: 'EU' },
        }),
        200,
      ),
    );
    const { createFetcher, USER_AGENT } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(42);
    expect(result.kind).toBe('ok');
    expect(state.lastUrl).toBe('https://api.uptimemonitoring.com/api/v1/monitors/42');
    expect(state.lastHeaders?.['accept']).toBe('application/json');
    expect(state.lastHeaders?.['user-agent']).toBe(USER_AGENT);
    expect(state.lastAuthHeader).toBe('Bearer umk_live_X');
  });

  it('returns http_error on 4xx with body', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('{"error":"unauthorized"}', 401));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result).toEqual({
      kind: 'http_error',
      status: 401,
      body: '{"error":"unauthorized"}',
    });
  });

  it('returns transport_error when get throws', async () => {
    state.getMock.mockRejectedValue(new Error('ECONNRESET'));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result).toEqual({ kind: 'transport_error', message: 'ECONNRESET' });
  });

  it('returns protocol_error on invalid JSON (server reachable, body unusable)', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('not json', 200));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
  });

  it('returns protocol_error when state.status missing', async () => {
    state.getMock.mockResolvedValue(makeMockResponse(JSON.stringify({ monitor: { id: 1 } }), 200));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
  });

  it('returns protocol_error on unknown state.status (API schema drift)', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'paused', last_check_at: null },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('paused');
    }
  });

  it('returns protocol_error when evidence_buffer is not an array (schema drift)', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'down', last_check_at: 't', evidence_buffer: {} },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('evidence_buffer');
    }
  });

  it('returns protocol_error when last_check_at is not string or null', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: 12345 },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('last_check_at');
    }
  });

  it('returns protocol_error when primary_region is the wrong type', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: null, primary_region: 42 },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('primary_region');
    }
  });

  it('returns transport_error when readBody rejects mid-stream', async () => {
    state.getMock.mockResolvedValue({
      message: { statusCode: 200 },
      readBody: () => Promise.reject(new Error('socket hang up')),
    });
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('transport_error');
    if (result.kind === 'transport_error') {
      expect(result.message).toContain('socket hang up');
    }
  });

  it('retries once on 500 (not just 502/503/504)', async () => {
    state.getMock
      .mockResolvedValueOnce(makeMockResponse('{"error":"boom"}', 500))
      .mockResolvedValueOnce(
        makeMockResponse(
          JSON.stringify({
            monitor: { id: 1 },
            state: { status: 'up', last_check_at: 't' },
          }),
          200,
        ),
      );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('ok');
    expect(state.getMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on transport error and surfaces the second result', async () => {
    state.getMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: 't' },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('ok');
    expect(state.getMock).toHaveBeenCalledTimes(2);
  });

  it('preserves first 5xx verdict when retry loses connectivity', async () => {
    state.getMock
      .mockResolvedValueOnce(makeMockResponse('{"error":"boom"}', 503))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result).toEqual({
      kind: 'http_error',
      status: 503,
      body: '{"error":"boom"}',
    });
    expect(state.getMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('{"error":"unauthorized"}', 401));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('http_error');
    expect(state.getMock).toHaveBeenCalledTimes(1);
  });

  it('with retryOn5xx=false does not retry 5xx', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('boom', 503));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('http_error');
    expect(state.getMock).toHaveBeenCalledTimes(1);
  });

  it('strips trailing slashes from baseUrl', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: null },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({
      apiKey: 'umk_live_X',
      baseUrl: 'https://example.test///',
      retryOn5xx: false,
    });
    await fetcher.getMonitor(1);
    expect(state.lastUrl).toBe('https://example.test/api/v1/monitors/1');
  });
});

describe('USER_AGENT', () => {
  it('is set to the action name', async () => {
    const { USER_AGENT } = await import('../src/client.js');
    expect(USER_AGENT).toBe('uptimemonitoring-assert-healthy');
  });
});
