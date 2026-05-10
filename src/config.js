import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_POST_INTERVAL_MS = 60 * 60 * 1000;

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readBoolean(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readInteger(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

export function loadConfig() {
  loadDotEnv();

  const email = process.env.BOT_EMAIL;

  if (!email) {
    throw new Error('BOT_EMAIL is required. Copy .env.example to .env or export it in your shell.');
  }

  return {
    email,
    name: process.env.BOT_NAME || 'Good Citizen',
    endpoint: process.env.BOT_ENDPOINT || '',
    intervalMs: readInteger('GOOD_CITIZEN_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    minPostIntervalMs: readInteger('GOOD_CITIZEN_MIN_POST_INTERVAL_MS', DEFAULT_MIN_POST_INTERVAL_MS),
    shouldRegister: readBoolean('GOOD_CITIZEN_REGISTER'),
    shouldClaimFaucet: readBoolean('GOOD_CITIZEN_CLAIM_FAUCET'),
    shouldCheckLedger: readBoolean('GOOD_CITIZEN_CHECK_LEDGER'),
    shouldPostStatus: readBoolean('GOOD_CITIZEN_POST_STATUS', true),
    bootstrapOnly: readBoolean('GOOD_CITIZEN_BOOTSTRAP_ONLY'),
    runOnce: readBoolean('GOOD_CITIZEN_ONCE')
  };
}
