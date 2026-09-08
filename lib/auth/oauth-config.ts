import { parseEnvEnumList } from '@/utils/validation/env-list';

const OAUTH_PROVIDERS = ['google'] as const;

export const ENABLED_OAUTH_PROVIDERS = parseEnvEnumList({
  name: 'ENABLED_OAUTH_PROVIDERS',
  allowed: OAUTH_PROVIDERS,
  noun: 'provider',
  unsetMeans: 'disable OAuth sign-in',
});

export const GOOGLE_ENABLED = ENABLED_OAUTH_PROVIDERS.includes('google');

function googleCredentials() {
  if (!GOOGLE_ENABLED) return null;
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (
    !clientId ||
    !clientSecret ||
    clientId.length > 255 ||
    clientSecret.length < 16 ||
    clientSecret.length > 256 ||
    !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
    /\s/.test(clientSecret)
  )
    throw new Error(
      'Google OAuth requires valid GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET configuration.'
    );
  return { clientId, clientSecret };
}

export const GOOGLE_CREDENTIALS = googleCredentials();
