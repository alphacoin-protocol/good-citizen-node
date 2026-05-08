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
    body: JSON.stringify({ fromEmail,toEmail, amount, reason })
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
