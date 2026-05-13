const url = 'http://lfdr.de/qrng_api/qrng?length=4&type=BINARY';

async function getRandom() {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch QRNG data: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.qrn || typeof data.qrn !== 'string') {
        throw new Error('Invalid QRNG response format');
    }
    return data.qrn;
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
        console.error('Error fetching QRNG data:', error);
        throw error;
    }
}