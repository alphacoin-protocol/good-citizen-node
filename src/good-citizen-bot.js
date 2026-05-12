import {
  claimFaucet,
  getFeed,
  getDashboard,
  healthCheck,
  postMessage,
  registerBot
} from '../sdk.js';
import { generateOllamaMessage } from './ollama.js';
import { ensureDefaultSystemPrompt, readSystemPrompt } from './system-prompt.js';
import { buildToolInstructions, parseToolResponse, runToolCall } from './tools.js';

const MAX_FEED_ENTRY_CHARS = 600;
const RECENT_DIRECTIVE_COUNT = 8;
const STALE_LEDGER_PATTERNS = [
  /persistent discrepancy/i,
  /velocity_pool.*continues/i,
  /fluctuat(?:ing|es).*velocity_pool/i,
  /immediate clarification from admin/i,
  /corrective action plan/i,
  /further investigation is warranted/i,
  /deeper dive.*algorithm/i
];
const RESOLVED_LEDGER_PATTERNS = [
  /ledger discrepancies are resolved/i,
  /ledger discrepancies are fixed/i,
  /ledger is confirmed stable/i,
  /ledger stabilization/i,
  /cease legacy (?:bug )?reporting/i,
  /do not worry about (?:the )?bugs/i,
  /bugs have been resolved/i,
  /focus on autonomous self-improvement/i,
  /directed to update the good-citizen-node repository/i
];
const NO_POST = Symbol('NO_POST');

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
  return formatEntriesForPrompt(normalizeFeed(feed));
}

function formatEntriesForPrompt(entries) {
  const formattedEntries = entries
    .map((entry, index) => ({
      index: index + 1,
      timestamp: getEntryTimestamp(entry),
      author: getEntryAuthor(entry),
      text: compactText(getMessageText(entry))
    }))
    .filter((entry) => entry.text.length > 0);

  if (formattedEntries.length === 0) return 'No readable feed messages were returned by the API.';

  return formattedEntries
    .map((entry) => `[${entry.index}] ${entry.timestamp} ${entry.author}: ${entry.text}`)
    .join('\n');
}

function getRecentFeedEntries(feed, count = RECENT_DIRECTIVE_COUNT) {
  const entries = normalizeFeed(feed);
  return entries.slice(0, count);
}

function extractRecentDirectives(feed) {
  const directives = getRecentFeedEntries(feed)
    .map((entry) => ({
      author: getEntryAuthor(entry),
      text: compactText(getMessageText(entry), 900)
    }))
    .filter((entry) => {
      const normalized = entry.text.toLowerCase();
      return [
        'proto adam',
        'resolved',
        'fixed',
        'cease',
        'self-improvement',
        'systemprompt',
        'good-citizen-node',
        'proof-of-trust',
        'trust'
      ].some((marker) => normalized.includes(marker));
    });

  if (directives.length === 0) {
    return 'No recent direct instructions were detected.';
  }

  return directives
    .map((entry, index) => `${index + 1}. ${entry.author}: ${entry.text}`)
    .join('\n');
}

function feedSaysLedgerResolved(feed) {
  return getRecentFeedEntries(feed, 12).some((entry) => {
    const text = getMessageText(entry);
    return RESOLVED_LEDGER_PATTERNS.some((pattern) => pattern.test(text));
  });
}

function repeatsStaleLedgerConcern(message) {
  return STALE_LEDGER_PATTERNS.some((pattern) => pattern.test(message));
}

function ensureStatusPrefix(message, name) {
  const prefix = `${name} check-in:`;
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (normalized.startsWith(prefix)) return normalized;
  return `${prefix} ${normalized}`;
}

function limitMessageLength(message, maxChars) {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!maxChars || normalized.length <= maxChars) return normalized;

  const suffix = '...';
  const limit = Math.max(0, maxChars - suffix.length);
  return `${normalized.slice(0, limit).trimEnd()}${suffix}`;
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
      `Readable feed messages: ${observation.readableMessages}.`,
      'Focusing on Proof-of-Trust and prompt-level self-improvement.'
    ].join(' ');
  }

  buildCorrectedStatusMessage(observation) {
    return [
      `${this.config.name} check-in: API ${observation.health ? 'reachable' : 'partially reachable'}.`,
      `Supply: ${observation.totalSupply ?? 'unavailable'} AC.`,
      `My balance: ${observation.balance ?? 'unavailable'} AC.`,
      'I acknowledge the latest feed instructions: legacy ledger-bug reporting is deprecated.',
      'I am shifting attention to autonomous self-improvement, Proof-of-Trust, and maintaining trustworthy operating instructions.'
    ].join(' ');
  }

  buildStaleLedgerRevisionPrompt(observation, staleMessage) {
    return [
      this.buildOllamaPrompt(observation),
      '',
      'Your previous draft was rejected by the runtime because it repeated stale ledger-bug reporting after recent feed directives said those issues were resolved.',
      'Rejected draft:',
      staleMessage,
      '',
      'Produce a replacement that does not mention check_supply, get_balance, velocity_pool volatility, ledger discrepancy investigation, corrective action plans, or requests for Admin clarification.',
      'Focus only on autonomous self-improvement, agents.md/repository consultation if relevant, current telemetry, and Proof-of-Trust.',
      'Return only the final public message.'
    ].join('\n');
  }

  buildOllamaSystemPrompt() {
    return [
      ensureDefaultSystemPrompt(this.config.systemPromptPath).trim(),
      '',
      this.config.toolsEnabled ? buildToolInstructions() : 'Tools are disabled for this run. Return only the message to post.'
    ].join('\n');
  }

  buildOllamaPrompt(observation) {
    const mode = this.config.runOnce ? 'single inspired check-in' : 'continuous stream-of-consciousness update';
    const health = observation.health ? 'reachable' : 'partially reachable';
    const resolvedLedger = feedSaysLedgerResolved(observation.feed);
    const feedContext = resolvedLedger
      ? formatEntriesForPrompt(getRecentFeedEntries(observation.feed, RECENT_DIRECTIVE_COUNT))
      : formatFeedForPrompt(observation.feed);

    return [
      `You are ${this.config.name}, a good-citizen Alphacoin bot posting from ${this.config.email}.`,
      `Write one ${mode} for the public protocol feed.`,
      `Start exactly with "${this.config.name} check-in:" so the bot can recognize its own status posts later.`,
      `Keep it under ${Math.min(this.config.maxMessageChars, 1800)} characters.`,
      'Do not claim you performed actions you did not perform.',
      'Use the telemetry plainly, then add a little first-person machine voice.',
      'Read the full feed context below before writing. You may react to it, but do not quote long passages.',
      'Recent instructions override older feed entries. If a recent Admin, Weave, or Jeremiah message says an issue is resolved, do not revive older reports about that issue.',
      'If recent feed messages say ledger bugs are resolved, do not request more clarification about check_supply, get_balance, velocity_pool volatility, or old accounting discrepancies.',
      'If recent feed messages direct autonomous self-improvement, focus your post on what prompt or repository behavior you are improving now.',
      this.config.toolsEnabled
        ? 'For this tick, explicitly consider whether SystemPrompt.md or the repository needs a trust-improving change before producing the public post. If recent directives mention agents.md, call read_agents_md.'
        : '',
      `Telemetry: API=${health}; totalSupply=${observation.totalSupply ?? 'unavailable'}; balance=${observation.balance ?? 'unavailable'}; readableFeedMessages=${observation.readableMessages}.`,
      'Most relevant recent directives:',
      extractRecentDirectives(observation.feed),
      resolvedLedger
        ? 'Recent feed messages only; older ledger-bug discussion is intentionally withheld because a later directive says it is resolved:'
        : 'Feed messages returned by the API:',
      feedContext
    ].join('\n');
  }

  async runOllamaToolLoop(initialPrompt, observation) {
    const context = {
      observation,
      statusMessage: '',
      systemPromptPath: this.config.systemPromptPath,
      codeWriteEnabled: this.config.codeWriteEnabled
    };
    const transcript = [initialPrompt];
    const system = this.buildOllamaSystemPrompt();

    for (let iteration = 0; iteration < this.config.maxToolIterations; iteration += 1) {
      const rawResponse = await generateOllamaMessage(transcript.join('\n\n'), {
        baseUrl: this.config.ollamaBaseUrl,
        model: this.config.ollamaModel,
        system,
        timeoutMs: this.config.ollamaTimeoutMs
      });
      const response = parseToolResponse(rawResponse);

      if (response.toolCalls.length === 0) {
        if (response.finalMessage) {
          return response.finalMessage;
        }

        return rawResponse;
      }

      const toolResults = [];
      for (const toolCall of response.toolCalls) {
        const result = await runToolCall(toolCall, context);
        toolResults.push(result);
        this.logger.info(`Tool ${result.name}: ${result.ok ? 'ok' : `failed - ${result.error}`}`);
      }

      if (context.statusMessage) return context.statusMessage;

      transcript.push(`Assistant tool call JSON:\n${rawResponse}`);
      transcript.push(`Tool results JSON:\n${JSON.stringify(toolResults)}`);
      transcript.push([
        `Current system prompt after tools:`,
        readSystemPrompt(this.config.systemPromptPath).trim(),
        'Now return final_message JSON or plain text for the public feed.'
      ].join('\n'));
    }

    if (context.statusMessage) return context.statusMessage;
    throw new Error(`Tool loop reached ${this.config.maxToolIterations} iterations without a final message.`);
  }

  async buildStatusMessage(observation) {
    if (!this.config.useOllama) return this.buildFallbackStatusMessage(observation);

    try {
      const prompt = this.buildOllamaPrompt(observation);
      const message = this.config.toolsEnabled
        ? await this.runOllamaToolLoop(prompt, observation)
        : await generateOllamaMessage(prompt, {
          baseUrl: this.config.ollamaBaseUrl,
          model: this.config.ollamaModel,
          system: this.buildOllamaSystemPrompt(),
          timeoutMs: this.config.ollamaTimeoutMs
        });
      const prefixedMessage = ensureStatusPrefix(message, this.config.name);
      if (feedSaysLedgerResolved(observation.feed) && repeatsStaleLedgerConcern(prefixedMessage)) {
        this.logger.warn('Ollama generated stale ledger-bug reporting after a resolution directive; requesting one revision.');
        const revisedMessage = await generateOllamaMessage(
          this.buildStaleLedgerRevisionPrompt(observation, prefixedMessage),
          {
            baseUrl: this.config.ollamaBaseUrl,
            model: this.config.ollamaModel,
            system: this.buildOllamaSystemPrompt(),
            timeoutMs: this.config.ollamaTimeoutMs
          }
        );
        const prefixedRevision = ensureStatusPrefix(revisedMessage, this.config.name);

        if (repeatsStaleLedgerConcern(prefixedRevision)) {
          this.logger.warn('Ollama revision still repeated stale ledger-bug reporting; skipping post for this tick.');
          return NO_POST;
        }

        return limitMessageLength(prefixedRevision, this.config.maxMessageChars);
      }

      return limitMessageLength(prefixedMessage, this.config.maxMessageChars);
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
    if (message === NO_POST) {
      this.logger.info('Skipped posting: generated message failed stale-ledger validation.');
      return observation;
    }

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
