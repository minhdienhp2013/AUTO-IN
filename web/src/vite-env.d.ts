/// <reference types="vite/client" />

/** Only client-exposed VITE_ configuration is available here. */
interface ImportMetaEnv {
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_API_BASE_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}