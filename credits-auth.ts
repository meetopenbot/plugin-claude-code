const INTEGRATIONS_TOKEN_HEADER = 'x-openbot-integrations-token';

/** Anthropic env overrides for OpenBot Credits (integrations gateway) billing. */
export const buildCreditsAnthropicEnv = (): Record<string, string> | undefined => {
  const integrationsBaseUrl = process.env.OPENBOT_INTEGRATIONS_BASE_URL?.trim();
  const integrationsToken = process.env.OPENBOT_INTEGRATIONS_TOKEN?.trim();
  if (!integrationsBaseUrl || !integrationsToken) return undefined;

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${integrationsBaseUrl.replace(/\/$/, '')}/anthropic/v1`,
    ANTHROPIC_CUSTOM_HEADERS: `${INTEGRATIONS_TOKEN_HEADER}: ${integrationsToken}`,
  };

  // Gateway replaces client auth; placeholder keeps the SDK from failing locally.
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    env.ANTHROPIC_API_KEY = 'openbot-credits';
  }

  return env;
};
