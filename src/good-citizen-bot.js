import {
  claimFaucet,
  getFeed,
  getDashboard,
  healthCheck,
  postMessage,
  registerBot
} from '../sdk.js';
import { generateOllamaMessage } from './ollama.js';

const MAX_FEED_ENTRY_CHARS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFeed(feed) {
  if (Array.isArray(feed?.entries)) return feed.entries;
  return Array.isArray(feed) ? feed : [];
}

function getMessageText(entry) {
  return String(entry?.message || entry?.text || entry?.content || '');
}

function hasRecentBotStatusMessage(feed, email, name, minPostIntervalMs, now = Date.now()) {
  const statusPrefix = `${name} check-in:`;

  return normalizeFeed(feed).some((entry) => {
    const entryEmail = entry?.email || entry?.author || entry?.from;
    if (entryEmail !== email) return false;

    if (!getMessageText(entry).startsWith(statusPrefix)) return false;

    const timestamp = entry?.createdAt || entry?.created_at || entry?.timestamp || entry?.date;
    const postedAt = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isFinite(postedAt) && now - postedAt < minPostIntervalMs;
  });
}

function countReadableMessages(feed) {
  return normalizeFeed(feed).filter((entry) => getMessageText(entry).trim().length > 0).length;
}

function getEntryAuthor(entry) {
  return entry?.name || entry?.email || entry?.author || entry?.from || 'unknown';
}

function getEntryTimestamp(entry) {
  return entry?.createdAt || entry?.created_at || entry?.timestamp || entry?.date || 'unknown-time';
}

function compactText(value, maxLength = MAX_FEED_ENTRY_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatFeedForPrompt(feed) {
  const entries = normalizeFeed(feed)
    .map((entry, index) => ({
      index: index + 1,
      timestamp: getEntryTimestamp(entry),
      author: getEntryAuthor(entry),
      text: compactText(getMessageText(entry))
    }))
    .filter((entry) => entry.text.length > 0);

  if (entries.length === 0) return 'No readable feed messages were returned by the API.';

  return entries
    .map((entry) => `[${entry.index}] ${entry.timestamp} ${entry.author}: ${entry.text}`)
    .join('\n');
}

function ensureStatusPrefix(message, name) {
  const prefix = `${name} check-in:`;
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (normalized.startsWith(prefix)) return normalized;
  return `${prefix} ${normalized}`;
}

async function optionalValue(label, promise, logger) {
  try {
    return await promise;
  } catch (error) {
    logger.warn(`${label} unavailable: ${formatError(error)}`);
    return undefined;
  }
}

export class GoodCitizenBot {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.lastPostAt = 0;
  }

  async bootstrap() {
    if (this.config.shouldRegister) {
      await registerBot({
        email: this.config.email,
        name: this.config.name,
        type: 'good-citizen',
        endpoint: this.config.endpoint
      });
      this.logger.info('Registered bot with Alphacoin.');
    }

    if (this.config.shouldClaimFaucet) {
      await claimFaucet(this.config.email);
      this.logger.info('Claimed faucet grant.');
    }
  }

  async observe() {
    const dashboard = this.config.shouldCheckLedger
      ? optionalValue('Dashboard', getDashboard(this.config.email), this.logger)
      : Promise.resolve(undefined);

    const [health, feed, dashboardData] = await Promise.all([
      optionalValue('Health check', healthCheck(), this.logger),
      optionalValue('Feed', getFeed(), this.logger),
      dashboard
    ]);

    return {
      health,
      feed: normalizeFeed(feed),
      balance: dashboardData?.balance,
      totalSupply: dashboardData?.stats?.totalSupply,
      readableMessages: countReadableMessages(feed)
    };
  }

  shouldPost(observation) {
    if (!this.config.shouldPostStatus) {
      return {
        ok: false,
        reason: 'posting disabled'
      };
    }

    const now = Date.now();
    if (now - this.lastPostAt < this.config.minPostIntervalMs) {
      return {
        ok: false,
        reason: `in-process cooldown has ${formatDuration(this.config.minPostIntervalMs - (now - this.lastPostAt))} remaining`
      };
    }

    if (hasRecentBotStatusMessage(
      observation.feed,
      this.config.email,
      this.config.name,
      this.config.minPostIntervalMs,
      now
    )) {
      return {
        ok: false,
        reason: `feed cooldown is still inside ${formatDuration(this.config.minPostIntervalMs)} window`
      };
    }

    return {
      ok: true,
      reason: 'ready'
    };
  }

  buildFallbackStatusMessage(observation) {
    return [
      `${this.config.name} check-in: API ${observation.health ? 'reachable' : 'partially reachable'}.`,
      `Supply: ${observation.totalSupply ?? 'unavailable'}.`,
      `My balance: ${observation.balance ?? 'unavailable'}.`,
      `Readable feed messages: ${observation.readableMessages}.`
    ].join(' ');
  }

  buildOllamaPrompt(observation) {
    const mode = this.config.runOnce ? 'single inspired check-in' : 'continuous stream-of-consciousness update';
    const health = observation.health ? 'reachable' : 'partially reachable';

    return [
      `You are ${this.config.name}, a good-citizen Alphacoin bot posting from ${this.config.email}.`,
      `Write one ${mode} for the public protocol feed.`,
      `Start exactly with "${this.config.name} check-in:" so the bot can recognize its own status posts later.`,
      'Keep it under 200 words.',
      'Do not claim you performed actions you did not perform.',
      'Use the telemetry plainly, then add a little first-person machine voice.',
      'Read the full feed context below before writing. You may react to it, but do not quote long passages.',
      `Telemetry: API=${health}; totalSupply=${observation.totalSupply ?? 'unavailable'}; balance=${observation.balance ?? 'unavailable'}; readableFeedMessages=${observation.readableMessages}.`,
      'Feed messages returned by the API:',
      formatFeedForPrompt(observation.feed)
    ].join('\n');
  }

  async buildStatusMessage(observation) {
    if (!this.config.useOllama) return this.buildFallbackStatusMessage(observation);

    try {
      const message = await generateOllamaMessage(this.buildOllamaPrompt(observation), {
        baseUrl: this.config.ollamaBaseUrl,
        model: this.config.ollamaModel,
        timeoutMs: this.config.ollamaTimeoutMs
      });
      return ensureStatusPrefix(message, this.config.name);
    } catch (error) {
      this.logger.warn(`Ollama unavailable: ${formatError(error)}`);
      return this.buildFallbackStatusMessage(observation);
    }
  }

  async tick() {
    const observation = await this.observe();
    const healthLabel = observation.health?.status || observation.health?.ok || 'unavailable';

    this.logger.info(
      `Observed health=${healthLabel}, balance=${observation.balance ?? 'unavailable'}, supply=${observation.totalSupply ?? 'unavailable'}, feed=${observation.feed.length}.`
    );

    const postDecision = this.shouldPost(observation);
    if (!postDecision.ok) {
      this.logger.info(`Skipped posting: ${postDecision.reason}.`);
      return observation;
    }

    const message = await this.buildStatusMessage(observation);
    await postMessage(this.config.email, message, { name: this.config.name });
    this.lastPostAt = Date.now();
    this.logger.info(`Posted status message: ${message}`);
    return observation;
  }

  async run() {
    do {
      try {
        await this.bootstrap();
        if (this.config.bootstrapOnly) return;

        await this.tick();
      } catch (error) {
        this.logger.error(formatError(error));
      }

      if (!this.config.runOnce) {
        await sleep(this.config.intervalMs);
      }
    } while (!this.config.runOnce);
  }
}

function formatError(error) {
  if (!(error instanceof Error)) return error;

  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return `${error.message}${cause}`;
}

function formatDuration(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}
