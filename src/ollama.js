const DEFAULT_TIMEOUT_MS = 60000;
import { getSeed } from './qrng.js';

export async function generateOllamaMessage(prompt, options = {}) {
  const {
    baseUrl = 'http://127.0.0.1:11434',
    model,
    system = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    seed
  } = options;

  if (!model) {
    throw new Error('OLLAMA_MODEL is required when GOOD_CITIZEN_USE_OLLAMA is enabled.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const finalSeed = seed !== undefined ? seed : await getSeed();

  try {
    const requestBody = {
      model,
      prompt,
      stream: false,
      raw: options.raw || false,
      options: {
        temperature: options.temperature || 0.2,
        num_predict: options.num_predict || 4096,
        num_ctx: 16384,
        seed: finalSeed
      }
    };

    // Ollama's raw mode does not support system prompts or templates.
    if (!options.raw && system) {
      requestBody.system = system;
    }

    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
    }

    const data = await response.json();
    const message = String(data.response || '');
    if (!message && !options.raw) throw new Error('Ollama returned an empty response.');
    return options.raw ? message : message.trim();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Ollama request timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}