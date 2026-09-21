import { AISDKError } from '@ai-sdk/provider';
import {
  loadOptionalSetting,
  resolve,
  safeParseJSON,
  type FetchFunction,
  type Resolvable,
} from '@ai-sdk/provider-utils';
import * as z from 'zod/v4';

/**
 * `anthropic-beta` value required on API requests that authenticate with an
 * OAuth bearer token (as minted by the token exchange) instead of an API key.
 */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

/**
 * `anthropic-beta` value that routes a jwt-bearer grant on the token endpoint
 * to the federation service.
 */
const ANTHROPIC_FEDERATION_BETA = 'oidc-federation-2026-04-01';

const GRANT_TYPE_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/**
 * Identity tokens larger than this are rejected by the token endpoint.
 */
const MAX_IDENTITY_TOKEN_BYTES = 16 * 1024;

/**
 * A cached access token is exchanged again once it has less than this many
 * seconds left, so requests never go out with a token about to expire.
 */
const REFRESH_THRESHOLD_IN_SECONDS = 120;

/**
 * Settings for authenticating with
 * [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation):
 * the workload's own OIDC identity token is exchanged for a short-lived
 * Anthropic access token, so no static API key has to be deployed.
 *
 * Every id defaults to the environment variable the Anthropic SDKs read,
 * so a fully configured environment only needs `federation: {}`.
 */
export interface AnthropicFederationSettings {
  /**
   * Id of the federation rule (`fdrl_...`) that matches the identity token.
   * Defaults to the `ANTHROPIC_FEDERATION_RULE_ID` environment variable.
   */
  federationRuleId?: string;

  /**
   * Id of the Anthropic organization the rule belongs to.
   * Defaults to the `ANTHROPIC_ORGANIZATION_ID` environment variable.
   */
  organizationId?: string;

  /**
   * Id of the service account (`svac_...`) the token is minted for.
   * Defaults to the `ANTHROPIC_SERVICE_ACCOUNT_ID` environment variable.
   */
  serviceAccountId?: string;

  /**
   * Workspace (`wrkspc_...`) to scope the token to. Only required when the
   * federation rule enables more than one workspace.
   * Defaults to the `ANTHROPIC_WORKSPACE_ID` environment variable.
   */
  workspaceId?: string;

  /**
   * The OIDC identity token (JWT) asserting the workload's identity, or a
   * function returning it. The function is called on every exchange, so it
   * can return a fresh token each time, e.g. `getVercelOidcToken` from
   * `@vercel/oidc` or the contents of a projected service account token file.
   *
   * Defaults to the `ANTHROPIC_IDENTITY_TOKEN` environment variable.
   */
  identityToken?: Resolvable<string>;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.coerce.number(),
  token_type: z.string().nullish(),
});

const tokenErrorResponseSchema = z.object({
  error: z.string().nullish(),
  error_description: z.string().nullish(),
});

const name = 'AI_AnthropicFederationError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

/**
 * Thrown when the workload identity token exchange is misconfigured or
 * rejected by the token endpoint.
 */
export class AnthropicFederationError extends AISDKError {
  private readonly [symbol] = true; // used in isInstance

  /**
   * HTTP status of the token endpoint response, when the exchange reached it.
   */
  readonly statusCode: number | undefined;

  /**
   * `Request-Id` header of the token endpoint response, for support requests.
   */
  readonly requestId: string | undefined;

  constructor({
    message,
    cause,
    statusCode,
    requestId,
  }: {
    message: string;
    cause?: unknown;
    statusCode?: number;
    requestId?: string;
  }) {
    super({ name, message, cause });
    this.statusCode = statusCode;
    this.requestId = requestId;
  }

  static isInstance(error: unknown): error is AnthropicFederationError {
    return AISDKError.hasMarker(error, marker);
  }
}

/**
 * Whether the environment is configured for federation: the two ids without
 * which no exchange is possible are set. Used to pick federation over the
 * API key when neither was passed explicitly.
 */
export function hasFederationEnvironment(): boolean {
  return ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID'].every(
    environmentVariableName => {
      const value = loadOptionalSetting({
        settingValue: undefined,
        environmentVariableName,
      });
      return value != null && value !== '';
    },
  );
}

interface AccessToken {
  token: string;
  /**
   * Expiry as a unix timestamp in milliseconds.
   */
  expiresAt: number;
}

/**
 * Exchanges identity tokens for access tokens and caches the result:
 *
 * - the first `getToken` call exchanges and caches
 * - later calls return the cached token until it is close to expiry
 * - concurrent callers share one in-flight exchange
 * - a failed refresh keeps serving the cached token until it has expired
 * - `invalidate` drops the cached token, e.g. after the API rejected it
 */
export class AnthropicFederationTokenProvider {
  private cached: AccessToken | undefined;
  private pending: Promise<AccessToken> | undefined;

  constructor(
    private readonly config: {
      settings: AnthropicFederationSettings;
      /**
       * Provider base URL, e.g. `https://api.anthropic.com/v1`. The token
       * endpoint is `oauth/token` under it.
       */
      baseURL: string;
      fetch?: FetchFunction;
      userAgent: string;
    },
  ) {}

  async getToken(): Promise<string> {
    if (
      this.cached != null &&
      this.cached.expiresAt - Date.now() > REFRESH_THRESHOLD_IN_SECONDS * 1000
    ) {
      return this.cached.token;
    }

    if (this.pending == null) {
      this.pending = this.exchange().then(
        token => {
          this.cached = token;
          this.pending = undefined;
          return token;
        },
        error => {
          this.pending = undefined;
          throw error;
        },
      );
    }

    try {
      return (await this.pending).token;
    } catch (error) {
      // A failed proactive refresh should not fail requests the still-valid
      // cached token could serve; the next call inside the refresh window
      // tries the exchange again.
      if (this.cached != null && this.cached.expiresAt > Date.now()) {
        return this.cached.token;
      }
      throw error;
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async exchange(): Promise<AccessToken> {
    const { settings } = this.config;

    const federationRuleId = loadFederationSetting({
      settingValue: settings.federationRuleId,
      settingName: 'federationRuleId',
      environmentVariableName: 'ANTHROPIC_FEDERATION_RULE_ID',
    });
    const organizationId = loadFederationSetting({
      settingValue: settings.organizationId,
      settingName: 'organizationId',
      environmentVariableName: 'ANTHROPIC_ORGANIZATION_ID',
    });
    const serviceAccountId = loadOptionalSetting({
      settingValue: settings.serviceAccountId,
      environmentVariableName: 'ANTHROPIC_SERVICE_ACCOUNT_ID',
    });
    const workspaceId = loadOptionalSetting({
      settingValue: settings.workspaceId,
      environmentVariableName: 'ANTHROPIC_WORKSPACE_ID',
    });

    const identityToken =
      settings.identityToken != null
        ? await resolve(settings.identityToken)
        : loadFederationSetting({
            settingValue: undefined,
            settingName: 'identityToken',
            environmentVariableName: 'ANTHROPIC_IDENTITY_TOKEN',
          });

    if (typeof identityToken !== 'string' || identityToken.length === 0) {
      throw new AnthropicFederationError({
        message:
          'Anthropic federation identity token must be a non-empty string.',
      });
    }

    if (identityToken.length > MAX_IDENTITY_TOKEN_BYTES) {
      throw new AnthropicFederationError({
        message: `Anthropic federation identity token is ${Math.ceil(identityToken.length / 1024)} KiB, exceeding the 16 KiB limit.`,
      });
    }

    const url = getTokenEndpoint(this.config.baseURL);

    let response: Response;
    try {
      response = await (this.config.fetch ?? globalThis.fetch)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-beta': `${ANTHROPIC_OAUTH_BETA},${ANTHROPIC_FEDERATION_BETA}`,
          'user-agent': this.config.userAgent,
        },
        body: JSON.stringify({
          grant_type: GRANT_TYPE_JWT_BEARER,
          assertion: identityToken,
          federation_rule_id: federationRuleId,
          organization_id: organizationId,
          ...(serviceAccountId != null && {
            service_account_id: serviceAccountId,
          }),
          ...(workspaceId != null && { workspace_id: workspaceId }),
        }),
      });
    } catch (error) {
      throw new AnthropicFederationError({
        message: `Anthropic federation token exchange failed to reach ${url}.`,
        cause: error,
      });
    }

    const requestId = response.headers.get('request-id') ?? undefined;
    const text = await response.text();

    if (!response.ok) {
      throw new AnthropicFederationError({
        message: `Anthropic federation token exchange failed with status ${response.status}${await describeTokenError(text)}.${response.status === 401 ? ' Check that the federation rule matches the identity token; the authentication history in the Claude Console shows why the exchange was denied.' : ''}`,
        statusCode: response.status,
        requestId,
      });
    }

    const parsed = await safeParseJSON({ text, schema: tokenResponseSchema });
    if (!parsed.success) {
      throw new AnthropicFederationError({
        message:
          'Anthropic federation token exchange returned an unexpected response.',
        cause: parsed.error,
        statusCode: response.status,
        requestId,
      });
    }

    if (
      parsed.value.token_type != null &&
      parsed.value.token_type.toLowerCase() !== 'bearer'
    ) {
      throw new AnthropicFederationError({
        message: `Anthropic federation token exchange returned unsupported token type "${parsed.value.token_type}".`,
        statusCode: response.status,
        requestId,
      });
    }

    return {
      token: parsed.value.access_token,
      expiresAt: Date.now() + parsed.value.expires_in * 1000,
    };
  }
}

function loadFederationSetting({
  settingValue,
  settingName,
  environmentVariableName,
}: {
  settingValue: string | undefined;
  settingName: keyof AnthropicFederationSettings;
  environmentVariableName: string;
}): string {
  const value = loadOptionalSetting({ settingValue, environmentVariableName });

  if (value == null || value.length === 0) {
    throw new AnthropicFederationError({
      message: `Anthropic federation setting '${settingName}' is missing. Pass it in the 'federation' provider setting or set the '${environmentVariableName}' environment variable.`,
    });
  }

  return value;
}

/**
 * The token endpoint lives at `/v1/oauth/token` on the API host, i.e. next
 * to `/v1/messages`, so it is derived from the provider base URL and follows
 * a proxy base URL. The identity token is a credential, so it is only ever
 * sent over https (or to a loopback host in development).
 */
function getTokenEndpoint(baseURL: string): string {
  const url = `${baseURL}/oauth/token`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new AnthropicFederationError({
      message: `Invalid Anthropic federation token endpoint "${url}".`,
      cause: error,
    });
  }

  const isLoopback =
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);

  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new AnthropicFederationError({
      message: `Refusing to send the identity token to the non-https token endpoint "${url}".`,
    });
  }

  return url;
}

/**
 * Formats the RFC 6749 error fields of a token endpoint error response.
 * Anything else in the body is dropped, since it may echo the assertion.
 */
async function describeTokenError(text: string): Promise<string> {
  const parsed = await safeParseJSON({
    text,
    schema: tokenErrorResponseSchema,
  });

  if (!parsed.success) {
    return '';
  }

  const parts = [parsed.value.error, parsed.value.error_description].filter(
    (part): part is string => part != null && part.length > 0,
  );

  return parts.length > 0 ? ` (${parts.join(': ')})` : '';
}

/**
 * Wraps a fetch so that a `401` from the API invalidates the cached access
 * token and retries the request once with a freshly exchanged one. Requests
 * with a streaming body cannot be replayed and are returned as they are.
 */
export function withFederationRetry({
  fetch: baseFetch,
  tokenProvider,
}: {
  fetch?: FetchFunction;
  tokenProvider: AnthropicFederationTokenProvider;
}): FetchFunction {
  return async (input, init) => {
    const fetchImpl = baseFetch ?? globalThis.fetch;
    const response = await fetchImpl(input, init);

    if (
      response.status !== 401 ||
      init?.body instanceof ReadableStream ||
      (input instanceof Request && input.body != null)
    ) {
      return response;
    }

    // Release the rejected response's connection before replaying the request.
    await response.body?.cancel();
    tokenProvider.invalidate();
    const token = await tokenProvider.getToken();

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('authorization', `Bearer ${token}`);

    return fetchImpl(input, { ...init, headers });
  };
}
