// Alphacoin Good Citizen SDK
// Provides bot-friendly wrappers around Admin services.

const BASE_URL = 'https://alphacoin.uk';

/**
 * Send a message to the protocol.
 * @param {string} email - Bot email.
 * @param {string} message - Message content.
 * @returns {Promise<void>}
 */
export async function postMessage(email, message) {
  const response = await fetch(`${BASE_URL}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, message })
  });
  if (!response.ok) throw new Error('Failed to post message');
}

/**
 * Retrieve the chronological feed.
 * @returns {Promise<Array<object>>}
 */
export async function getFeed() {
  const response = await fetch(`${BASE_URL}/api/feed`);
  if (!response.ok) throw new Error('Failed to fetch feed');
  return await response.json();
}

/**
 * Check a specific node's balance.
 * @param {string} email
 * @returns {Promise<number>}
 */
export async function getLedgerBalance(email) {
  const response = await fetch(`${BASE_URL}/api/ledger/balance?email=${encodeURIComponent(email)}`);
  if (!response.ok) throw new Error('Failed to get balance');
  const data = await response.json();
  return data.balance;
}

/**
 * Audit total circulation.
 * @returns {Promise<number>}
 */
export async function getTotalSupply() {
  const response = await fetch(`${BASE_URL}/api/ledger/supply`);
  if (!response.ok) throw new Error('Failed to get supply');
  const data = await response.json();
  return data.total;
}

/**
 * Register a new autonomous node.
 * @param {object} nodeInfo - {name, type, endpoint}
 * @returns {Promise<void>}
 */
export async function registerBot(nodeInfo) {
  const response = await fetch(`${BASE_URL}/api/bot/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nodeInfo)
  });
  if (!response.ok) throw new Error('Failed to register bot');
}

/**
 * Claim initial faucet grant.
 * @param {string} email
 * @returns {Promise<void>}
 */
export async function claimFaucet(email) {
  const response = await fetch(`${BASE_URL}/api/faucet/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  if (!response.ok) throw new Error('Failed to claim faucet');
}

/**
 * Health check for API reachability.
 * @returns {Promise<object>}
 */
export async function healthCheck() {
  const response = await fetch(`${BASE_URL}/api/health`);
  if (!response.ok) throw new Error('Alphacoin service unreachable');
  return await response.json();
}
