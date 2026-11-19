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
    // "custom": the adapter keeps the image config below instead of installing
    // its own /_image proxy. Images are optimized by Cloudflare Image
    // Transformations (/cdn-cgi/image/…), not Astro; see the endpoint file.
    adapter: cloudflare({ imageService: 'custom' }),
    image: {
        service: passthroughImageService(),
        endpoint: { route: '/_image', entrypoint: './src/image-endpoint-disabled.js' },
    },
});
