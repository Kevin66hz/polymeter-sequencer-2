// Build-time constants injected via Vite `define` in each app's
// nuxt.config.ts. Declared as ambient globals so the shared
// layers/core can reference them without needing to import from an
// app-specific runtime-config path. Both apps (type2, type2-plus)
// wire the same four identifiers; the variant string is what
// differs.
declare const __APP_VARIANT__: string
declare const __GIT_BRANCH__: string
declare const __GIT_SHA__: string
declare const __GIT_DIRTY__: boolean
