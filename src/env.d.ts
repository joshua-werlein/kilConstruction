/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// noinspection JSUnusedGlobalSymbols

declare module '*.svg' {
    const src: string;
    export default src;
}

interface ImportMetaEnv {
    readonly PUBLIC_GALLERY_API: string;
}

// Bindings are read through src/utils/runtimeEnv.ts (cloudflare:workers);
// Astro.locals.runtime no longer exists in @astrojs/cloudflare 13+.