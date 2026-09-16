/// <reference types="vite/client" />

/**
 * Typed environment variables.
 *
 * `VITE_DEFAULT_PERIOD` exists because the demonstration data is dated 2026:
 * defaulting to the real current month would show an empty dashboard on a fresh
 * checkout.
 */
interface ImportMetaEnv {
  readonly VITE_DEFAULT_PERIOD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
