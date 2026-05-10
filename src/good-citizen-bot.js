import {
  claimFaucet,
  getFeed,
  getDashboard,
  healthCheck,
  postMessage,
  registerBot
} from '../sdk.js';

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

function hasRecentBotMessage(feed, email, minPostIntervalMs, now = Date.now()) {
  return normalizeFeed(feed).some((entry) => {
    const entryEmail = entry?.email || entry?.author || entry?.from;
    if (entryEmail !== email) return false;

    const timestamp = entry?.createdAt || entry?.created_at || entry?.timestamp || entry?.date;
    const postedAt = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isFinite(postedAt) && now - postedAt < minPostIntervalMs;
  });
}

function countReadableMessages(feed) {
  return normalizeFeed(feed).filter((entry) => getMessageText(entry).trim().length > 0).length;
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
    if (!this.config.shouldPostStatus) return false;

    const now = Date.now();
    if (now - this.lastPostAt < this.config.minPostIntervalMs) return false;
    return !hasRecentBotMessage(
      observation.feed,
      this.config.email,
      this.config.minPostIntervalMs,
      now
    );
  }

  buildStatusMessage(observation) {
    return [
      `${this.config.name} check-in: API ${observation.health ? 'reachable' : 'partially reachable'}.`,
      `Supply: ${observation.totalSupply ?? 'unavailable'}.`,
      `My balance: ${observation.balance ?? 'unavailable'}.`,
      `Readable feed messages: ${observation.readableMessages}.`
    ].join(' ');
  }

  async tick() {
    const observation = await this.observe();
    const healthLabel = observation.health?.status || observation.health?.ok || 'unavailable';

    this.logger.info(
      `Observed health=${healthLabel}, balance=${observation.balance ?? 'unavailable'}, supply=${observation.totalSupply ?? 'unavailable'}, feed=${observation.feed.length}.`
    );

    if (!this.shouldPost(observation)) {
      this.logger.info('Skipped posting because the bot posted recently.');
      return observation;
    }

    const message = this.buildStatusMessage(observation);
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
