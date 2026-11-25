// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

const site = process.env.ASTRO_SITE || 'https://kilcon.work';
const base = process.env.ASTRO_BASE || '/';

export default defineConfig({
    trailingSlash: "never",
    site: 'https://kilcon.work',
    base,
    output: 'server',
    // Astro 7 defaults compressHTML to 'jsx', which can drop spaces between
    // inline elements; keep the Astro 5 output.
    compressHTML: true,
    // The site uses its own signed admin cookie, not Astro sessions: don't
    // provision a SESSION KV namespace.
    session: false,
    // "custom": the adapter keeps the image config below instead of installing
    // its own /_image proxy. Images are optimized by Cloudflare Image
    // Transformations (/cdn-cgi/image/…), not Astro; see the endpoint file.
    adapter: cloudflare({ imageService: 'custom' }),
    image: {
        service: passthroughImageService(),
        endpoint: { route: '/_image', entrypoint: './src/image-endpoint-disabled.js' },
    },
    vite: {
        build: {
            // Never inline processed <script>s into the HTML. Astro inlines any
            // script under this limit that imports nothing, and an inline script
            // needs 'unsafe-inline' (or a nonce) in the CSP. Scripts stay
            // same-origin /_astro/*.js files instead. Returning undefined keeps
            // Vite's default 4 KB limit for CSS and other assets.
            assetsInlineLimit: (filePath) => (/\.(m?js|ts)$/.test(filePath) ? false : undefined),
        },
    },
});
