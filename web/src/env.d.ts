/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PWA_MOBILE_SHELL?: string
  readonly VITE_PWA_SERVICE_WORKER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
