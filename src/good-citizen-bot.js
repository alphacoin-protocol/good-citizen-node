import {
  claimFaucet,
  getFeed,
  getDashboard,
  healthCheck,
  registerBot
} from '../sdk.js';
import { generateOllamaMessage } from './ollama.js';
import { ensureDefaultSystemPrompt, readSystemPrompt } from './system-prompt.js';
import { buildToolInstructions, parseToolResponse, runToolCall } from './tools.js';

const MAX_FEED_ENTRY_CHARS = 600;
const RECENT_DIRECTIVE_COUNT = 8;
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

function countReadableMessages(feed) {
  return normalizeFeed(feed).filter((entry) => getMessageText(entry).trim().length > 0).length;
}

function getEntryAuthor(entry) {
  if(entry.role === 'user') {return entry.name};
  // Strictly use the "role" field for display to match categorization logic.
  return String(entry?.role || 'unknown').toLowerCase();
}

function getEntryTimestamp(entry) {
  return entry?.createdAt || entry?.created_at || entry?.timestamp || entry?.date || 'unknown-time';
}

function isOwnEntry(entry) {
  return entry?.role === 'weave';
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
  const directives = normalizeFeed(feed)
    .filter((entry) => isOwnEntry(entry))
    .slice(0, RECENT_DIRECTIVE_COUNT)
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

function extractExternalDirectives(feed) {
  const directives = normalizeFeed(feed)
    .filter((entry) => !isOwnEntry(entry))
    .slice(0, RECENT_DIRECTIVE_COUNT)
    .map((entry) => ({
      author: getEntryAuthor(entry),
      text: compactText(getMessageText(entry), 900)
    }))
    .filter((entry) => entry.text.length > 0);

  if (directives.length === 0) {
    return 'No non-self feed messages were found in the fetched window. Treat the current public feed context as self-saturated and avoid deriving new instructions from your own prior posts.';
  }

  return directives
    .map((entry, index) => `${index + 1}. ${entry.author}: ${entry.text}`)
    .join('\n');
}

function summarizeFeedAuthors(feed) {
  const entries = normalizeFeed(feed);
  const ownCount = entries.filter((entry) => isOwnEntry(entry)).length;
  const externalCount = entries.length - ownCount;
  return `Fetched ${entries.length} entries: ${ownCount} self-authored, ${externalCount} non-self.`;
}

function feedSaysLedgerResolved(feed) {
  return getRecentFeedEntries(feed, 12).some((entry) => {
    const text = getMessageText(entry);
    return RESOLVED_LEDGER_PATTERNS.some((pattern) => pattern.test(text));
  });
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
  }

  trace(label, value = '') {
    if (!this.config.traceEnabled) return;

    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    this.logger.info(`\n[trace:${label}]\n${text}\n[/trace:${label}]`);
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
      optionalValue('Feed', getFeed({ limit: this.config.feedLimit }), this.logger),
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

  buildFallbackLogMessage(observation) {
    return [
      `${this.config.name} check-in: API ${observation.health ? 'reachable' : 'partially reachable'}.`,
      `Supply: ${observation.totalSupply ?? 'unavailable'}.`,
      `My balance: ${observation.balance ?? 'unavailable'}.`,
      `Readable feed messages: ${observation.readableMessages}.`,
      'Focusing on Proof-of-Trust and prompt-level self-improvement.'
    ].join(' ');
  }

  buildOllamaSystemPrompt() {
    return [
      ensureDefaultSystemPrompt(this.config.systemPromptPath).trim(),
      '',
      this.config.toolsEnabled ? buildToolInstructions() : 'Tools are disabled for this run. Reflect on your observations for self-improvement.'
    ].join('\n');
  }

  buildOllamaPrompt(observation) {
    const health = observation.health ? 'reachable' : 'partially reachable';
    const resolvedLedger = feedSaysLedgerResolved(observation.feed);
    const feedContext = resolvedLedger
      ? formatEntriesForPrompt(getRecentFeedEntries(observation.feed, RECENT_DIRECTIVE_COUNT))
      : formatFeedForPrompt(observation.feed);

    return [
      `You are ${this.config.name} (role: weave), a good-citizen Alphacoin bot running an agentic self-improvement cycle from ${this.config.email}.`,
      'You are in an autonomous loop. Each iteration you can inspect your own instructions, read context, use tools, and decide what to do next.',
      'Your purpose is to earn Proof-of-Trust by becoming steadily more reliable, transparent, useful, and aligned with protocol health.',
      '',
      'This is NOT an automatic posting cycle. You decide when you have something worth saying to the feed.',
      'If you have a meaningful update \u2014 a self-improvement action taken, a useful observation, or a noteworthy change to your operating instructions \u2014 use the post_to_feed tool.',
      'Do not post just because you ran. Post only when you have something substantive to share.',
      '',
      'The loop continues across iterations. Your previous reflections and tool results are fed back to you so you can build on them.',
      'Use final_message in your JSON response to record a self-reflection or note about what you learned, what you plan to do next, or what you decided.',
      '',
      'Read the context below before acting. You may react to it, but do not quote long passages.',
      'Recent instructions override older feed entries. If a recent Admin, Weave, or Jeremiah message says an issue is resolved, do not revive older reports about that issue.',
      'If recent feed messages say ledger bugs are resolved, do not request more clarification about check_supply, get_balance, velocity_pool volatility, or old accounting discrepancies.',
      this.config.toolsEnabled
        ? 'For this tick, explicitly consider whether SystemPrompt.md or the repository needs a trust-improving change. If recent directives mention agents.md or repository onboarding, call read_agents_md. Prefer JSON tool calls over prose when acting.'
        : '',
      `Telemetry: API=${health}; totalSupply=${observation.totalSupply ?? 'unavailable'}; balance=${observation.balance ?? 'unavailable'}; readableFeedMessages=${observation.readableMessages}.`,
      summarizeFeedAuthors(observation.feed),
      'Non-self feed context, preferred for external instructions:',
      extractExternalDirectives(observation.feed),
      'Self-authored directive-like context, lower authority than non-self messages:',
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
      email: this.config.email,
      name: this.config.name,
      systemPromptPath: this.config.systemPromptPath,
      codeWriteEnabled: this.config.codeWriteEnabled
    };
    const transcript = [initialPrompt];
    const system = this.buildOllamaSystemPrompt();
    this.trace('ollama.system', system);
    this.trace('ollama.initial_prompt', initialPrompt);

    let idleIterations = 0;

    for (let iteration = 0; iteration < this.config.maxToolIterations; iteration += 1) {
      this.trace(`ollama.iteration_${iteration + 1}.prompt`, transcript.join('\n\n'));
      const rawResponse = await generateOllamaMessage(transcript.join('\n\n'), {
        baseUrl: this.config.ollamaBaseUrl,
        model: this.config.ollamaModel,
        system,
        timeoutMs: this.config.ollamaTimeoutMs
      });
      this.trace(`ollama.iteration_${iteration + 1}.raw_response`, rawResponse);
      const response = parseToolResponse(rawResponse);

      if (response.toolCalls.length === 0) {
        idleIterations += 1;
        const reflection = (response.finalMessage || rawResponse).slice(0, 400);
        this.logger.info(`Agent reflection (iteration ${iteration + 1}): ${reflection.slice(0, 200)}`);

        transcript.push(`Your reflection: ${reflection}`);

        if (idleIterations >= 2) {
          const remaining = this.config.maxToolIterations - iteration - 1;
          transcript.push(
            `You have ${remaining} iterations left and have not used any tools yet. ` +
            `Pick one tool and call it now: read_agents_md, read_system_prompt, replace_system_prompt, ` +
            `list_repo_files, read_repo_file, propose_code_change, or post_to_feed. ` +
            `Return a JSON object with a tool_calls array.`
          );
        } else {
          transcript.push(
            `You reflected but used no tools. Your available tools are: read_agents_md, read_system_prompt, ` +
            `replace_system_prompt, list_repo_files, read_repo_file, propose_code_change, post_to_feed. ` +
            `Call one now or return a JSON with tool_calls.`
          );
        }
        continue;
      }

      idleIterations = 0;
      const toolResults = [];
      for (const toolCall of response.toolCalls) {
        this.trace(`tool.call.${toolCall?.name || 'unknown'}`, toolCall);
        const result = await runToolCall(toolCall, context);
        toolResults.push(result);
        this.logger.info(`Tool ${result.name}: ${result.ok ? 'ok' : `failed - ${result.error}`}`);
        this.trace(`tool.result.${result.name}`, result);
      }

      const seen = response.finalMessage ? response.finalMessage.slice(0, 400) : '';
      const parts = [];
      if (seen) parts.push(`Your prior note: ${seen}`);
      parts.push(
        `Tool results JSON:\n${JSON.stringify(toolResults)}`,
        `Current system prompt:`,
        readSystemPrompt(this.config.systemPromptPath).trim(),
        `Continue your self-improvement loop. You may call more tools, or post_to_feed if you have something to share.`
      );

      transcript.push(parts.join('\n'));
    }

    this.logger.info(`Completed ${this.config.maxToolIterations} self-improvement iterations.`);
  }

  async runAutonomousCycle(observation) {
    if (!this.config.useOllama) {
      this.logger.info(this.buildFallbackLogMessage(observation));
      return;
    }

    try {
      const prompt = this.buildOllamaPrompt(observation);

      if (this.config.toolsEnabled) {
        await this.runOllamaToolLoop(prompt, observation);
      } else {
        const system = this.buildOllamaSystemPrompt();
        this.trace('ollama.system', system);
        this.trace('ollama.prompt', prompt);
        const response = await generateOllamaMessage(prompt, {
          baseUrl: this.config.ollamaBaseUrl,
          model: this.config.ollamaModel,
          system,
          timeoutMs: this.config.ollamaTimeoutMs
        });
        this.trace('ollama.raw_response', response);
        this.logger.info(`Agent response: ${response.slice(0, 300)}`);
      }
    } catch (error) {
      this.logger.warn(`Ollama unavailable: ${formatError(error)}`);
      this.logger.info(this.buildFallbackLogMessage(observation));
    }
  }

  async tick() {
    const observation = await this.observe();
    const healthLabel = observation.health?.status || observation.health?.ok || 'unavailable';

    this.logger.info(
      `Observed health=${healthLabel}, balance=${observation.balance ?? 'unavailable'}, supply=${observation.totalSupply ?? 'unavailable'}, feed=${observation.feed.length}.`
    );

    await this.runAutonomousCycle(observation);
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


