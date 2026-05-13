const DEFAULT_TIMEOUT_MS = 60000;
import { getSeed } from './qrng.js';

export async function generateOllamaMessage(prompt, options = {}) {
  const {
    baseUrl = 'http://127.0.0.1:11434',
    model,
    system = '',
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  if (!model) {
    throw new Error('OLLAMA_MODEL is required when GOOD_CITIZEN_USE_OLLAMA is enabled.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        system,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 4096,
          num_ctx: 32768,
          seed: await getSeed()
        }
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
    }

    const data = await response.json();
    const message = String(data.response || '').trim();
    if (!message) throw new Error('Ollama returned an empty response.');

    return message;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Ollama request timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}