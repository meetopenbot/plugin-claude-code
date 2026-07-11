export const INTEGRATIONS_TOKEN_HEADER = 'x-openbot-integrations-token';
export const CREDITS_API_KEY_PLACEHOLDER = 'openbot-credits';

export interface CreditsAuthConfig {
  baseUrl: string;
  token: string;
}

/** Cloud host injects these when routing LLM calls through OpenBot Credits. */
export const resolveCreditsAuthConfig = (): CreditsAuthConfig | undefined => {
  const baseUrl = process.env.OPENBOT_INTEGRATIONS_BASE_URL?.trim();
  const token = process.env.OPENBOT_INTEGRATIONS_TOKEN?.trim();
  if (!baseUrl || !token) return undefined;
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
};

/** Anthropic env overrides for OpenBot Credits (integrations gateway) billing. */
export const buildCreditsAnthropicEnv = (): Record<string, string> | undefined => {
  const config = resolveCreditsAuthConfig();
  if (!config) return undefined;

  // Any non-empty key satisfies the SDK; the integrations gateway authenticates via header.
  const apiKey = config.token || CREDITS_API_KEY_PLACEHOLDER;

  return {
    ANTHROPIC_BASE_URL: `${config.baseUrl}/anthropic`,
    ANTHROPIC_CUSTOM_HEADERS: `${INTEGRATIONS_TOKEN_HEADER}: ${config.token}`,
    ANTHROPIC_API_KEY: apiKey,
    // Prevent the CLI from preferring stored OAuth over gateway routing.
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_AUTH_TOKEN: '',
  };
};
