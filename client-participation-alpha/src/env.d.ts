/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SERVICE_URL: string;
  readonly PUBLIC_OIDC_CACHE_KEY_PREFIX: string;
  readonly PUBLIC_OIDC_CACHE_KEY_ID_TOKEN_SUFFIX: string;
  readonly INTERNAL_SERVICE_URL: string;
  // Add other environment variables as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
