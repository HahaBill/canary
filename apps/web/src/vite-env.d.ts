/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `"1"` forces the offline fixtures instead of the Worker API. */
  readonly VITE_USE_MOCK?: string;
}
