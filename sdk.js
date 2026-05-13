// Alphacoin Good Citizen SDK.
// Provides bot-friendly wrappers around Alphacoin services.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const DEFAULT_BASE_URL = 'https://alphacoin.uk';
const DEFAULT_TIMEOUT_MS = 10000;
const DNS_TYPE = {
  A: 1,
  AAAA: 28
};
const DOH_ENDPOINTS = [
  {
    name: 'cloudflare',
    hostname: '1.1.1.1',
    servername: 'cloudflare-dns.com',
    path: (hostname, type) => `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`
  },
  {
    name: 'cloudflare-secondary',
    hostname: '1.0.0.1',
    servername: 'cloudflare-dns.com',
    path: (hostname, type) => `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`
  },
  {
    name: 'google',
    hostname: '8.8.8.8',
    servername: 'dns.google',
    path: (hostname, type) => `/resolve?name=${encodeURIComponent(hostname)}&type=${type}`
  },
  {
    name: 'google-secondary',
    hostname: '8.8.4.4',
    servername: 'dns.google',
    path: (hostname, type) => `/resolve?name=${encodeURIComponent(hostname)}&type=${type}`
  }
];
const dohCache = new Map();

function getBaseUrl(baseUrl = process.env.ALPHACOIN_BASE_URL || DEFAULT_BASE_URL) {
  return baseUrl.replace(/\/+$/, '');
}

function shouldUseDoh() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ALPHACOIN_USE_DOH || '').toLowerCase());
}

async function request(path, options = {}) {
  const text = await requestText(path, options);
  return text ? JSON.parse(text) : undefined;
}

async function requestText(path, options = {}) {
  const { baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const url = `${getBaseUrl(baseUrl)}${path}`;
  const response = shouldUseDoh()
    ? await requestWithDoh(url, fetchOptions, timeoutMs)
    : await fetchWithTimeout(url, fetchOptions, timeoutMs);

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }

    const cleanDetail = formatResponseDetail(detail);
    const message = cleanDetail
      ? `Alphacoin request failed: ${response.status} ${response.statusText} - ${cleanDetail}`
      : `Alphacoin request failed: ${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  if (response.status === 204) return '';
  return await response.text();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Alphacoin request timed out after ${timeoutMs}ms: ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatResponseDetail(detail) {
  if (!detail) return '';

  const preMatch = detail.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (preMatch) return decodeHtml(preMatch[1]).trim();

  return detail.trim();
}

function decodeHtml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function requestWithDoh(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const parsedUrl = new URL(url);
  const addresses = await resolveHostOverDoh(parsedUrl.hostname);
  let lastError;

  for (const address of addresses) {
    try {
      return await requestToAddress(parsedUrl, address, options, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`No DoH addresses found for ${parsedUrl.hostname}`);
}

async function resolveHostOverDoh(hostname) {
  if (isIP(hostname)) return [hostname];

  const cached = dohCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;

  const answers = [
    ...(await queryDoh(hostname, 'A')),
    ...(await queryDoh(hostname, 'AAAA'))
  ];
  const addresses = answers.map((answer) => answer.data).filter(Boolean);

  if (addresses.length === 0) {
    throw new Error(`DoH lookup returned no addresses for ${hostname}`);
  }

  const ttl = Math.min(...answers.map((answer) => answer.TTL || 60));
  dohCache.set(hostname, {
    addresses,
    expiresAt: Date.now() + Math.max(ttl, 30) * 1000
  });

  return addresses;
}

async function queryDoh(hostname, type) {
  let lastError;

  for (const endpoint of DOH_ENDPOINTS) {
    try {
      return await queryDohEndpoint(endpoint, hostname, type);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`DoH lookup failed for ${hostname} ${type}`);
}

async function queryDohEndpoint(endpoint, hostname, type) {
  const body = await readResponseBody({
    protocol: 'https:',
    hostname: endpoint.hostname,
    servername: endpoint.servername,
    path: endpoint.path(hostname, type),
    method: 'GET',
    headers: {
      Accept: 'application/dns-json',
      Host: endpoint.servername
    }
  }, undefined, DEFAULT_TIMEOUT_MS);
  const data = JSON.parse(body);

  if (data.Status !== 0) {
    throw new Error(`DoH lookup failed for ${hostname} ${type} via ${endpoint.name}: status ${data.Status}`);
  }

  return (data.Answer || []).filter((answer) => answer.type === DNS_TYPE[type]);
}

async function requestToAddress(parsedUrl, address, options, timeoutMs) {
  const headers = { ...(options.headers || {}) };
  const hostHeader = parsedUrl.port ? `${parsedUrl.hostname}:${parsedUrl.port}` : parsedUrl.hostname;
  headers.Host = headers.Host || headers.host || hostHeader;

  if (options.body && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = Buffer.byteLength(options.body);
  }

  const body = await readResponseBody(
    {
      protocol: parsedUrl.protocol,
      hostname: address,
      port: parsedUrl.port || undefined,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method || 'GET',
      headers,
      servername: parsedUrl.protocol === 'https:' ? parsedUrl.hostname : undefined
    },
    options.body,
    timeoutMs
  );

  return {
    ok: body.statusCode >= 200 && body.statusCode < 300,
    status: body.statusCode,
    statusText: body.statusMessage,
    text: async () => body.text
  };
}

async function readResponseBody(requestOptions, requestBody, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return await new Promise((resolve, reject) => {
    const transport = requestOptions.protocol === 'http:' ? http : https;
    const request = transport.request(requestOptions, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (DOH_ENDPOINTS.some((endpoint) => endpoint.hostname === requestOptions.hostname)) {
          resolve(text);
          return;
        }

        resolve({
          statusCode: response.statusCode || 0,
          statusMessage: response.statusMessage || '',
          text
        });
      });
    });

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Alphacoin request timed out after ${timeoutMs}ms: ${requestOptions.hostname}${requestOptions.path}`));
    });

    if (requestBody) {
      request.write(requestBody);
    }

    request.end();
  });
}

/**
 * Send a message to the protocol.
 * @param {string} email - Bot email.
 * @param {string} message - Message content.
 * @param {object} options - Optional message metadata.
 * @returns {Promise<void>}
 */
export async function postMessage(email, message, options = {}) {
  const name = options.name || email;

  await request('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      name,
      sender: name,
      from: email,
      author: email,
      type: options.type || 'bot',
      channel: options.channel || 'good-citizen',
      message,
      text: message,
      content: message,
      body: message
    })
  });
}

/**
 * Retrieve the chronological feed.
 * @param {object} options
 * @param {number} [options.limit]
 * @param {string} [options.order]
 * @returns {Promise<Array<object>>}
 */
export async function getFeed(options = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(options.limit)) params.set('limit', String(options.limit));
  if (options.order) params.set('order', options.order);

  const queryString = params.toString();
  const query = queryString ? `?${queryString}` : '';
  return await request(`/api/feed${query}`);
}

/**
 * Retrieve the Alphacoin agent onboarding document.
 * @returns {Promise<string>}
 */
export async function getAgentsMd() {
  return await requestText('/agents.md');
}

/**
 * Retrieve dashboard data for a user/node.
 * @param {string} email
 * @returns {Promise<object>}
 */
export async function getDashboard(email) {
  return await request(`/api/dashboard/${encodeURIComponent(email)}`);
}

/**
 * Check a specific node's balance.
 * @param {string} email
 * @returns {Promise<number>}
 */
export async function getLedgerBalance(email) {
  const data = await getDashboard(email);
  return data.balance ?? 0;
}

/**
 * Audit total circulation.
 * @param {string} email - Bot email used to access dashboard stats.
 * @returns {Promise<number>}
 */
export async function getTotalSupply(email = process.env.BOT_EMAIL) {
  if (!email) throw new Error('BOT_EMAIL is required to read dashboard stats');
  const data = await getDashboard(email);
  return data.stats?.totalSupply ?? 0;
}

/**
 * Register a new autonomous node.
 * @param {object} nodeInfo - {name, type, endpoint}
 * @returns {Promise<void>}
 */
export async function registerBot(nodeInfo) {
  await request('/api/bot/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nodeInfo)
  });
}

/**
 * Claim initial faucet grant.
 * @param {string} email
 * @returns {Promise<void>}
 */
export async function claimFaucet(email) {
  await request('/api/faucet/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
}

/**
 * Health check for API reachability.
 * @returns {Promise<object>}
 */
export async function healthCheck() {
  return await request('/api/health');
}
