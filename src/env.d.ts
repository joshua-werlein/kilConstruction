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

type Env = {
    GALLERY_WORKER: Fetcher;
};
type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
    interface Locals extends Runtime {}
}