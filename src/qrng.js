const url = 'http://lfdr.de/qrng_api/qrng?length=4&type=BINARY';
const TIMEOUT_MS = 5000;

async function getRandom() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
        throw new Error(`Failed to fetch QRNG data: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.qrn || typeof data.qrn !== 'string') {
        throw new Error('Invalid QRNG response format');
    }
    return data.qrn;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`QRNG request timed out after ${TIMEOUT_MS}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function getSeed() {
    try {
        const binaryString = await getRandom();
        // Convert the binary string to an unsigned 32-bit integer.
        // parseInt(binaryString, 2) converts the binary string to a base-10 number.
        // The >>> 0 operator ensures the result is treated as an unsigned 32-bit integer,
        // effectively clamping it to the range [0, 4294967295].
        const uint32Seed = parseInt(binaryString, 2) >>> 0;
        return uint32Seed;
    } catch (error) {
        // Fallback to a local random seed if the QRNG service is unreachable.
        // This ensures the bot keeps running even on poor WiFi.
        const fallbackSeed = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
        console.warn(`QRNG unavailable (${error.message}). Using local fallback seed: ${fallbackSeed}`);
        return fallbackSeed;
    }
}