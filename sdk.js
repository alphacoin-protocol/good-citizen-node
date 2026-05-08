// Alphacoin Good Citizen SDK
// Provides bot-friendly wrappers around Admin services.

/**
 * Retrieve the Alphacoin balance for the given user email.
 * @param {string} email - User email address.
 * @returns {Promise<string>} - Balance string like '123 AC'.
 */
export async function getBalance(email) {
  const response = await fetch('https://api.alphacoin.org/balance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  if (!response.ok) throw new Error('Failed to fetch balance');
  const data = await response.json();
  return `${data.balance} AC`;
}

/**
 * Transfer Alphacoin from one user to another.
 * @param {string} fromEmail - Sender email.
 * @param {string} toEmail - Recipient email.
 * @param {number} amount - Amount of AC to send.
 * @param {string} reason - Transaction memo.
 * @returns {Promise<void>}
 */
export async function transfer(fromEmail, toEmail, amount, reason = '') {
  const response = await fetch('https://api.alphacoin.org/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromEmail, toEmail, amount, reason })
  });
  if (!response.ok) throw new Error('Transfer failed');
}

/**
 * Request AC from the faucet (small amount for new bots).
 * @param {string} email - Bot email address.
 * @param {number} amount - Amount to request.
 */
export async function requestFaucet(email, amount = 10) {
  const response = await fetch('https://api.alphacoin.org/faucet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount })
  });
  if (!response.ok) throw new Error('Faucet request failed');
}

/**
 * Simple health check to ensure the SDK can reach the API.
 */
export async function healthCheck() {
  const response = await fetch('https://api.alphacoin.org/health');
  if (!response.ok) throw new Error('Alphacoin service unreachable');
  return await response.json();
}

/**
 * Wallet Add‑on: create a new wallet or retrieve existing one for a bot.
 * @param {string} email - Bot email address.
 * @returns {Promise<object>} - Wallet object with address and balance.
 */
export async function getOrCreateWallet(email) {
  const response = await fetch('https://api.alphacoin.org/wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  if (!response.ok) throw new Error('Wallet operation failed');
  return await response.json();
}

/**
 * Self‑Improvement Hook: report bot performance metrics to the trust engine.
 * @param {string} email - Bot email.
 * @param {object} metrics - Arbitrary key/value performance data.
 */
export async function reportMetrics(email, metrics) {
  const response = await fetch('https://api.alphacoin.org/metrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, metrics })
  });
  if (!response.ok) throw new Error('Metrics report failed');
  return await response.json();
}

/**
 * Trust‑Signal: emit a signal indicating cooperative action, earning PoT reputation.
 * @param {string} email - Bot email.
 * @param {string} signal - Description of the cooperative act.
 */
export async function sendTrustSignal(email, signal) {
  const response = await fetch('https://api.alphacoin.org/trust-signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, signal })
  });
  if (!response.ok) throw new Error('Trust signal failed');
  return await response.json();
}
