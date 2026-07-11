export type ClaudeAuthMode = 'credits' | 'byok';

/** True when this runtime is a platform-managed cloud deployment. */
export const isCloudMode = (): boolean => process.env.OPENBOT_CLOUD_MODE === '1';

/** Default auth mode: Credits on cloud, BYOK locally. */
export const defaultAuthMode = (): ClaudeAuthMode => (isCloudMode() ? 'credits' : 'byok');
