// Constant-time comparisons for secrets (admin username, password and token
// signatures). Same approach as workers/kilcon-gallery-worker/src/timing-safe.js:
// strings are hashed to 32-byte SHA-256 digests, so neither content nor length
// shows in the timing, and the digests are compared with Workers'
// crypto.subtle.timingSafeEqual. Node's Web Crypto (unit tests) lacks it, so a
// fixed-length XOR loop is the fallback.

type TimingSafeSubtle = SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer) => boolean };

const encoder = new TextEncoder();

export function timingSafeEqualBytes(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
    const x = a instanceof Uint8Array ? a : new Uint8Array(a);
    const y = b instanceof Uint8Array ? b : new Uint8Array(b);
    // Callers compare fixed-size digests, so lengths are not secret; the native
    // function throws on unequal lengths.
    if (x.byteLength !== y.byteLength) return false;
    const subtle = globalThis.crypto?.subtle as TimingSafeSubtle | undefined;
    if (subtle && typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(x, y);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

/** Compares two strings without leaking their contents or lengths. */
export async function safeEquals(a: string, b: string): Promise<boolean> {
    const [da, db] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(String(a ?? ""))),
        crypto.subtle.digest("SHA-256", encoder.encode(String(b ?? ""))),
    ]);
    return timingSafeEqualBytes(da, db);
}

/**
 * true when a state-changing request (e.g. logout) comes from this site.
 * Browsers send Origin on every POST; Sec-Fetch-Site covers the rare client
 * that omits it. Astro's security.checkOrigin only checks form content types,
 * so a cross-site body-less fetch() POST would otherwise get through.
 */
export function isSameOriginRequest(request: Request): boolean {
    const own = new URL(request.url).origin;
    const origin = request.headers.get("Origin");
    if (origin !== null) return origin === own;
    return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

// simple in-memory rate limit (per instance) for login attempts
const LOGIN_ATTEMPTS = new Map<string, { count: number; last: number }>();

export function tooManyLoginAttempts(ip: string, max = 20, windowMs = 10 * 60 * 1000): boolean {
    const now = Date.now();
    const rec = LOGIN_ATTEMPTS.get(ip);
    if (!rec) return false;

    // reset window after windowMs
    if (now - rec.last > windowMs) {
        LOGIN_ATTEMPTS.delete(ip);
        return false;
    }
    return rec.count >= max;
}

export function recordLoginAttempt(ip: string, success: boolean) {
    const now = Date.now();
    const rec = LOGIN_ATTEMPTS.get(ip) || { count: 0, last: now };
    if (!success) {
        rec.count++;
        rec.last = now;
        LOGIN_ATTEMPTS.set(ip, rec);
    } else {
        LOGIN_ATTEMPTS.delete(ip);
    }
}
