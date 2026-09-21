/* eslint-disable turbo/no-undeclared-env-vars */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidArgumentError,
  type LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import {
  AnthropicFederationError,
  AnthropicFederationTokenProvider,
} from './anthropic-federation';
import { createAnthropic } from './anthropic-provider';

vi.mock('./version', () => ({
  VERSION: '0.0.0-test',
}));

const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

const TEST_PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
];

const FEDERATION_ENV = {
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
  ANTHROPIC_ORGANIZATION_ID: 'org_test',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
  ANTHROPIC_WORKSPACE_ID: 'wrkspc_test',
  ANTHROPIC_IDENTITY_TOKEN: 'identity.jwt.env',
} as const;

const AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  ...Object.keys(FEDERATION_ENV),
];

function tokenResponse({
  accessToken = 'access-token',
  expiresIn = 3600,
  tokenType = 'Bearer',
}: {
  accessToken?: string;
  expiresIn?: number;
  tokenType?: string | null;
} = {}) {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: expiresIn,
      ...(tokenType != null && { token_type: tokenType }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function messageResponse() {
  return new Response(
    JSON.stringify({
      type: 'message',
      id: 'msg_123',
      model: 'claude-3-haiku-20240307',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function unauthorizedResponse() {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid token' },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * A fetch mock that answers token exchanges and API calls separately.
 */
function createFetchMock({
  token = () => tokenResponse(),
  api = () => messageResponse(),
}: {
  token?: () => Response;
  api?: () => Response;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return url === TOKEN_URL ? token() : api();
  });
}

function callsTo(fetchMock: ReturnType<typeof createFetchMock>, url: string) {
  return fetchMock.mock.calls.filter(([input]) => input === url);
}

function headersOf(call: unknown[]) {
  return new Headers((call[1] as RequestInit).headers);
}

async function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('workload identity federation', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of AUTH_ENV_VARS) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const name of AUTH_ENV_VARS) {
      if (originalEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[name];
      }
    }
  });

  describe('AnthropicFederationTokenProvider', () => {
    it('exchanges the identity token with the settings and environment', async () => {
      process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_env';
      const fetchMock = createFetchMock();

      const provider = new AnthropicFederationTokenProvider({
        settings: {
          federationRuleId: 'fdrl_123',
          organizationId: 'org_123',
          serviceAccountId: 'svac_123',
          identityToken: async () => 'identity.jwt',
        },
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'ai-sdk/anthropic/0.0.0-test',
      });

      expect(await provider.getToken()).toBe('access-token');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [call] = fetchMock.mock.calls;
      expect(call[0]).toBe(TOKEN_URL);
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(Object.fromEntries(headersOf(call).entries())).toEqual({
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20,oidc-federation-2026-04-01',
        'user-agent': 'ai-sdk/anthropic/0.0.0-test',
      });
      expect(await bodyOf(call)).toEqual({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: 'identity.jwt',
        federation_rule_id: 'fdrl_123',
        organization_id: 'org_123',
        service_account_id: 'svac_123',
        workspace_id: 'wrkspc_env',
      });
    });

    it('reads all settings from the environment', async () => {
      Object.assign(process.env, FEDERATION_ENV);
      const fetchMock = createFetchMock();

      const provider = new AnthropicFederationTokenProvider({
        settings: {},
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'test',
      });

      await provider.getToken();

      expect(await bodyOf(fetchMock.mock.calls[0])).toEqual({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: 'identity.jwt.env',
        federation_rule_id: 'fdrl_test',
        organization_id: 'org_test',
        service_account_id: 'svac_test',
        workspace_id: 'wrkspc_test',
      });
    });

    it('omits the optional service account and workspace ids', async () => {
      const fetchMock = createFetchMock();

      const provider = new AnthropicFederationTokenProvider({
        settings: {
          federationRuleId: 'fdrl_123',
          organizationId: 'org_123',
          identityToken: 'identity.jwt',
        },
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'test',
      });

      await provider.getToken();

      expect(await bodyOf(fetchMock.mock.calls[0])).toEqual({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: 'identity.jwt',
        federation_rule_id: 'fdrl_123',
        organization_id: 'org_123',
      });
    });

    it('caches the token and shares one exchange between concurrent callers', async () => {
      const fetchMock = createFetchMock();
      const provider = new AnthropicFederationTokenProvider({
        settings: {
          federationRuleId: 'fdrl_123',
          organizationId: 'org_123',
          identityToken: 'identity.jwt',
        },
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'test',
      });

      const tokens = await Promise.all([
        provider.getToken(),
        provider.getToken(),
        provider.getToken(),
      ]);
      expect(tokens).toEqual(['access-token', 'access-token', 'access-token']);
      expect(await provider.getToken()).toBe('access-token');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('exchanges again when the token is about to expire', async () => {
      vi.useFakeTimers();
      let exchanges = 0;
      const fetchMock = createFetchMock({
        token: () => tokenResponse({ accessToken: `token-${++exchanges}` }),
      });
      const provider = new AnthropicFederationTokenProvider({
        settings: {
          federationRuleId: 'fdrl_123',
          organizationId: 'org_123',
          identityToken: 'identity.jwt',
        },
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'test',
      });

      expect(await provider.getToken()).toBe('token-1');

      // still fresh with 10 minutes left
      vi.advanceTimersByTime(50 * 60 * 1000);
      expect(await provider.getToken()).toBe('token-1');

      // inside the refresh window with 1 minute left
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(await provider.getToken()).toBe('token-2');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('exchanges again after invalidate', async () => {
      let exchanges = 0;
      const fetchMock = createFetchMock({
        token: () => tokenResponse({ accessToken: `token-${++exchanges}` }),
      });
      const provider = new AnthropicFederationTokenProvider({
        settings: {
          federationRuleId: 'fdrl_123',
          organizationId: 'org_123',
          identityToken: 'identity.jwt',
        },
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'test',
      });

      expect(await provider.getToken()).toBe('token-1');
      provider.invalidate();
      expect(await provider.getToken()).toBe('token-2');
    });

    it('calls the identity token function on every exchange', async () => {
      const identityToken = vi
        .fn()
        .mockResolvedValueOnce('identity.jwt.1')
        .mockResolvedValueOnce('identity.jwt.2');
      const fetchMock = createFetchMock();
      const provider = new AnthropicFederationTokenProvider({
        settings: {
          federationRuleId: 'fdrl_123',
          organizationId: 'org_123',
          identityToken,
        },
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'test',
      });

      await provider.getToken();
      provider.invalidate();
      await provider.getToken();

      expect(identityToken).toHaveBeenCalledTimes(2);
      expect((await bodyOf(fetchMock.mock.calls[0])).assertion).toBe(
        'identity.jwt.1',
      );
      expect((await bodyOf(fetchMock.mock.calls[1])).assertion).toBe(
        'identity.jwt.2',
      );
    });

    it('does not cache a failed exchange', async () => {
      let attempts = 0;
      const fetchMock = createFetchMock({
        token: () =>
          ++attempts === 1
            ? new Response('unavailable', { status: 503 })
            : tokenResponse(),
      });
      const provider = new AnthropicFederationTokenProvider({
        settings: {
          federationRuleId: 'fdrl_123',
          organizationId: 'org_123',
          identityToken: 'identity.jwt',
        },
        baseURL: 'https://api.anthropic.com/v1',
        fetch: fetchMock,
        userAgent: 'test',
      });

      await expect(provider.getToken()).rejects.toThrow(
        AnthropicFederationError,
      );
      expect(await provider.getToken()).toBe('access-token');
    });

    describe('errors', () => {
      const validSettings = {
        federationRuleId: 'fdrl_123',
        organizationId: 'org_123',
        identityToken: 'identity.jwt',
      };

      function createProvider(
        overrides: Partial<
          ConstructorParameters<typeof AnthropicFederationTokenProvider>[0]
        > & { settings?: Record<string, unknown> } = {},
      ) {
        return new AnthropicFederationTokenProvider({
          settings: validSettings,
          baseURL: 'https://api.anthropic.com/v1',
          fetch: createFetchMock(),
          userAgent: 'test',
          ...overrides,
        });
      }

      it('reports a missing federation rule id', async () => {
        await expect(
          createProvider({
            settings: { ...validSettings, federationRuleId: undefined },
          }).getToken(),
        ).rejects.toThrow(
          "Anthropic federation setting 'federationRuleId' is missing. Pass it in the 'federation' provider setting or set the 'ANTHROPIC_FEDERATION_RULE_ID' environment variable.",
        );
      });

      it('reports a missing organization id', async () => {
        await expect(
          createProvider({
            settings: { ...validSettings, organizationId: undefined },
          }).getToken(),
        ).rejects.toThrow(
          "Anthropic federation setting 'organizationId' is missing.",
        );
      });

      it('reports a missing identity token', async () => {
        await expect(
          createProvider({
            settings: { ...validSettings, identityToken: undefined },
          }).getToken(),
        ).rejects.toThrow(
          "Anthropic federation setting 'identityToken' is missing. Pass it in the 'federation' provider setting or set the 'ANTHROPIC_IDENTITY_TOKEN' environment variable.",
        );
      });

      it('rejects an empty identity token', async () => {
        await expect(
          createProvider({
            settings: { ...validSettings, identityToken: async () => '' },
          }).getToken(),
        ).rejects.toThrow(
          'Anthropic federation identity token must be a non-empty string.',
        );
      });

      it('rejects an oversized identity token without sending it', async () => {
        const fetchMock = createFetchMock();
        await expect(
          createProvider({
            settings: {
              ...validSettings,
              identityToken: 'x'.repeat(16 * 1024 + 1),
            },
            fetch: fetchMock,
          }).getToken(),
        ).rejects.toThrow('exceeding the 16 KiB limit');
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('refuses a non-https token endpoint', async () => {
        const fetchMock = createFetchMock();
        await expect(
          createProvider({
            baseURL: 'http://proxy.example/v1',
            fetch: fetchMock,
          }).getToken(),
        ).rejects.toThrow(
          'Refusing to send the identity token to the non-https token endpoint "http://proxy.example/v1/oauth/token".',
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('allows a loopback http token endpoint', async () => {
        const fetchMock = vi.fn(
          async (_input: RequestInfo | URL, _init?: RequestInit) =>
            tokenResponse(),
        );
        await createProvider({
          baseURL: 'http://localhost:8080/v1',
          fetch: fetchMock,
        }).getToken();
        expect(fetchMock.mock.calls[0]![0]).toBe(
          'http://localhost:8080/v1/oauth/token',
        );
      });

      it('surfaces the RFC 6749 error fields and status of a rejected exchange', async () => {
        let error: unknown;
        try {
          await createProvider({
            fetch: vi.fn(
              async () =>
                new Response(
                  JSON.stringify({
                    error: 'invalid_grant',
                    error_description: 'rule does not match',
                    assertion: 'must-not-be-echoed',
                  }),
                  { status: 401, headers: { 'request-id': 'req_123' } },
                ),
            ),
          }).getToken();
        } catch (e) {
          error = e;
        }

        expect(AnthropicFederationError.isInstance(error)).toBe(true);
        const federationError = error as AnthropicFederationError;
        expect(federationError.statusCode).toBe(401);
        expect(federationError.requestId).toBe('req_123');
        expect(federationError.message).toBe(
          'Anthropic federation token exchange failed with status 401 (invalid_grant: rule does not match). Check that the federation rule matches the identity token; the authentication history in the Claude Console shows why the exchange was denied.',
        );
        expect(federationError.message).not.toContain('must-not-be-echoed');
      });

      it('reports a non-JSON error body without echoing it', async () => {
        await expect(
          createProvider({
            fetch: vi.fn(
              async () => new Response('<html>gateway</html>', { status: 502 }),
            ),
          }).getToken(),
        ).rejects.toThrow(
          'Anthropic federation token exchange failed with status 502.',
        );
      });

      it('rejects a response without an access token', async () => {
        await expect(
          createProvider({
            fetch: vi.fn(
              async () =>
                new Response(JSON.stringify({ expires_in: 3600 }), {
                  status: 200,
                }),
            ),
          }).getToken(),
        ).rejects.toThrow(
          'Anthropic federation token exchange returned an unexpected response.',
        );
      });

      it('rejects a non-bearer token type', async () => {
        await expect(
          createProvider({
            fetch: vi.fn(async () => tokenResponse({ tokenType: 'MAC' })),
          }).getToken(),
        ).rejects.toThrow(
          'Anthropic federation token exchange returned unsupported token type "MAC".',
        );
      });

      it('wraps a network failure', async () => {
        const cause = new TypeError('fetch failed');
        let error: unknown;
        try {
          await createProvider({
            fetch: vi.fn(async () => {
              throw cause;
            }),
          }).getToken();
        } catch (e) {
          error = e;
        }

        expect(AnthropicFederationError.isInstance(error)).toBe(true);
        expect((error as AnthropicFederationError).message).toBe(
          'Anthropic federation token exchange failed to reach https://api.anthropic.com/v1/oauth/token.',
        );
        expect((error as AnthropicFederationError).cause).toBe(cause);
      });
    });
  });

  describe('createAnthropic', () => {
    const federation = {
      federationRuleId: 'fdrl_123',
      organizationId: 'org_123',
      identityToken: 'identity.jwt',
    };

    it('sends the federated bearer token and the OAuth beta instead of an API key', async () => {
      const fetchMock = createFetchMock();
      const provider = createAnthropic({ federation, fetch: fetchMock });

      await provider('claude-3-haiku-20240307').doGenerate({
        prompt: TEST_PROMPT,
      });

      const [messagesCall] = callsTo(fetchMock, MESSAGES_URL);
      const headers = headersOf(messagesCall!);
      expect(headers.get('authorization')).toBe('Bearer access-token');
      expect(headers.get('x-api-key')).toBeNull();
      expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
    });

    it('does not exchange until the first request', async () => {
      const fetchMock = createFetchMock();
      createAnthropic({ federation, fetch: fetchMock });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the OAuth beta alongside request betas', async () => {
      const fetchMock = createFetchMock();
      const provider = createAnthropic({
        federation,
        fetch: fetchMock,
        headers: { 'anthropic-beta': 'custom-beta' },
      });

      await provider('claude-3-haiku-20240307').doGenerate({
        prompt: TEST_PROMPT,
        headers: { 'anthropic-beta': 'request-beta' },
      });

      const [messagesCall] = callsTo(fetchMock, MESSAGES_URL);
      expect(
        headersOf(messagesCall!).get('anthropic-beta')?.split(','),
      ).toEqual(
        expect.arrayContaining([
          'oauth-2025-04-20',
          'custom-beta',
          'request-beta',
        ]),
      );
    });

    it('keeps the OAuth beta on file uploads', async () => {
      const fetchMock = createFetchMock({
        api: () =>
          new Response(
            JSON.stringify({
              id: 'file_123',
              type: 'file',
              filename: 'test.txt',
              mime_type: 'text/plain',
              size_bytes: 4,
              created_at: '2025-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      });
      const provider = createAnthropic({ federation, fetch: fetchMock });

      await provider.files().uploadFile({
        data: { type: 'data', data: new Uint8Array([1, 2, 3, 4]) },
        mediaType: 'text/plain',
        filename: 'test.txt',
        providerOptions: {},
      });

      const [uploadCall] = callsTo(
        fetchMock,
        'https://api.anthropic.com/v1/files',
      );
      const headers = headersOf(uploadCall!);
      expect(headers.get('authorization')).toBe('Bearer access-token');
      expect(headers.get('anthropic-beta')).toBe(
        'oauth-2025-04-20,files-api-2025-04-14',
      );
    });

    it('reuses the token across requests', async () => {
      const fetchMock = createFetchMock();
      const provider = createAnthropic({ federation, fetch: fetchMock });
      const model = provider('claude-3-haiku-20240307');

      await model.doGenerate({ prompt: TEST_PROMPT });
      await model.doGenerate({ prompt: TEST_PROMPT });

      expect(callsTo(fetchMock, TOKEN_URL)).toHaveLength(1);
      expect(callsTo(fetchMock, MESSAGES_URL)).toHaveLength(2);
    });

    it('retries once with a fresh token when the API returns 401', async () => {
      let exchanges = 0;
      let apiCalls = 0;
      const fetchMock = createFetchMock({
        token: () => tokenResponse({ accessToken: `token-${++exchanges}` }),
        api: () =>
          ++apiCalls === 1 ? unauthorizedResponse() : messageResponse(),
      });
      const provider = createAnthropic({ federation, fetch: fetchMock });

      const result = await provider('claude-3-haiku-20240307').doGenerate({
        prompt: TEST_PROMPT,
      });

      expect(result.content).toEqual([{ type: 'text', text: 'Hi' }]);
      const messagesCalls = callsTo(fetchMock, MESSAGES_URL);
      expect(messagesCalls).toHaveLength(2);
      expect(headersOf(messagesCalls[0]!).get('authorization')).toBe(
        'Bearer token-1',
      );
      expect(headersOf(messagesCalls[1]!).get('authorization')).toBe(
        'Bearer token-2',
      );
      expect((messagesCalls[1]![1] as RequestInit).body).toBe(
        (messagesCalls[0]![1] as RequestInit).body,
      );
    });

    it('does not retry a second 401', async () => {
      const fetchMock = createFetchMock({ api: () => unauthorizedResponse() });
      const provider = createAnthropic({ federation, fetch: fetchMock });

      await expect(
        provider('claude-3-haiku-20240307').doGenerate({
          prompt: TEST_PROMPT,
        }),
      ).rejects.toThrow();

      expect(callsTo(fetchMock, MESSAGES_URL)).toHaveLength(2);
      expect(callsTo(fetchMock, TOKEN_URL)).toHaveLength(2);
    });

    it('uses federation when only the federation environment is configured', async () => {
      Object.assign(process.env, FEDERATION_ENV);
      const fetchMock = createFetchMock();

      await createAnthropic({ fetch: fetchMock })(
        'claude-3-haiku-20240307',
      ).doGenerate({ prompt: TEST_PROMPT });

      expect(callsTo(fetchMock, TOKEN_URL)).toHaveLength(1);
      const [messagesCall] = callsTo(fetchMock, MESSAGES_URL);
      expect(headersOf(messagesCall!).get('authorization')).toBe(
        'Bearer access-token',
      );
    });

    it('prefers ANTHROPIC_API_KEY over the federation environment', async () => {
      Object.assign(process.env, FEDERATION_ENV);
      process.env.ANTHROPIC_API_KEY = 'env-api-key';
      const fetchMock = createFetchMock();

      await createAnthropic({ fetch: fetchMock })(
        'claude-3-haiku-20240307',
      ).doGenerate({ prompt: TEST_PROMPT });

      expect(callsTo(fetchMock, TOKEN_URL)).toHaveLength(0);
      const [messagesCall] = callsTo(fetchMock, MESSAGES_URL);
      const headers = headersOf(messagesCall!);
      expect(headers.get('x-api-key')).toBe('env-api-key');
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('anthropic-beta')).toBeNull();
    });

    it('prefers an explicit apiKey over the federation environment', async () => {
      Object.assign(process.env, FEDERATION_ENV);
      const fetchMock = createFetchMock();

      await createAnthropic({ apiKey: 'explicit-key', fetch: fetchMock })(
        'claude-3-haiku-20240307',
      ).doGenerate({ prompt: TEST_PROMPT });

      expect(callsTo(fetchMock, TOKEN_URL)).toHaveLength(0);
      const [messagesCall] = callsTo(fetchMock, MESSAGES_URL);
      expect(headersOf(messagesCall!).get('x-api-key')).toBe('explicit-key');
    });

    it('prefers an explicit federation setting over ANTHROPIC_API_KEY', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-api-key';
      const fetchMock = createFetchMock();

      await createAnthropic({ federation, fetch: fetchMock })(
        'claude-3-haiku-20240307',
      ).doGenerate({ prompt: TEST_PROMPT });

      const [messagesCall] = callsTo(fetchMock, MESSAGES_URL);
      const headers = headersOf(messagesCall!);
      expect(headers.get('authorization')).toBe('Bearer access-token');
      expect(headers.get('x-api-key')).toBeNull();
    });

    it('rejects federation combined with apiKey', () => {
      expect(() => createAnthropic({ federation, apiKey: 'key' })).toThrowError(
        InvalidArgumentError,
      );
    });

    it('rejects federation combined with authToken', () => {
      expect(() =>
        createAnthropic({ federation, authToken: 'token' }),
      ).toThrowError(InvalidArgumentError);
    });

    it('derives the token endpoint from a custom base URL', async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/oauth/token')
          ? tokenResponse()
          : messageResponse(),
      );

      await createAnthropic({
        federation,
        baseURL: 'https://proxy.example/anthropic/v1',
        fetch: fetchMock,
      })('claude-3-haiku-20240307').doGenerate({ prompt: TEST_PROMPT });

      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        'https://proxy.example/anthropic/v1/oauth/token',
        'https://proxy.example/anthropic/v1/messages',
      ]);
    });
  });
});
