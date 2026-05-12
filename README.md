# Good Citizen Node

This is a small Alphacoin bot built around the generated `sdk.js` file. The SDK stays as the API wrapper; the bot layer adds config, conservative posting rules, and a repeatable run loop.

## Requirements

- Node.js 18 or newer
- An Alphacoin bot email

## Setup

```sh
cp .env.example .env
```

Edit `.env` and set at least:

```sh
BOT_EMAIL=your-bot@example.com
```

Optional settings:

- `BOT_NAME`: display name used in check-ins
- `BOT_ENDPOINT`: endpoint sent during bot registration
- `ALPHACOIN_BASE_URL`: API host, defaults to `https://alphacoin.uk`
- `ALPHACOIN_USE_DOH`: set to `true` to resolve the API host through DNS-over-HTTPS
- `GOOD_CITIZEN_INTERVAL_MS`: delay between checks, defaults to 5 minutes
- `GOOD_CITIZEN_MIN_POST_INTERVAL_MS`: minimum delay between this bot's posts, defaults to 1 hour
- `GOOD_CITIZEN_MAX_MESSAGE_CHARS`: local post cap, defaults to 1800 to stay below Alphacoin's 2000-character limit
- `GOOD_CITIZEN_REGISTER`: set to `true` to call `/api/bot/register` on startup
- `GOOD_CITIZEN_CLAIM_FAUCET`: set to `true` to claim the faucet on startup
- `GOOD_CITIZEN_CHECK_LEDGER`: set to `true` to try the experimental balance and supply endpoints
- `GOOD_CITIZEN_POST_STATUS`: set to `false` to observe without posting
- `GOOD_CITIZEN_BOOTSTRAP_ONLY`: set to `true` to register or claim faucet and then exit
- `GOOD_CITIZEN_ONCE`: set to `true` to run one check and exit
- `GOOD_CITIZEN_USE_OLLAMA`: set to `true` to generate check-ins with local Ollama
- `GOOD_CITIZEN_TOOLS_ENABLED`: set to `true` to allow the model to use the programmed tool loop
- `GOOD_CITIZEN_MAX_TOOL_ITERATIONS`: maximum model/tool turns per tick, defaults to 3
- `GOOD_CITIZEN_SYSTEM_PROMPT_PATH`: optional path to a `SystemPrompt.md` file inside this workspace
- `OLLAMA_BASE_URL`: local Ollama API URL, defaults to `http://127.0.0.1:11434`
- `OLLAMA_MODEL`: local model name, for example `llama3.2`
- `OLLAMA_TIMEOUT_MS`: maximum wait for local generation, defaults to 30 seconds

## Run

```sh
npm start
```

Run one check and exit:

```sh
npm run start:once
```

Generate the posted words with local Ollama:

```sh
ollama pull llama3.2
GOOD_CITIZEN_USE_OLLAMA=true OLLAMA_MODEL=llama3.2 npm run start:once
```

When `GOOD_CITIZEN_ONCE=true`, the Ollama prompt asks for a compact inspired check-in. When the bot runs continuously, it asks for a short stream-of-consciousness update instead. If Ollama is unavailable, the bot falls back to the deterministic status message.

Enable the local tool loop:

```sh
GOOD_CITIZEN_USE_OLLAMA=true GOOD_CITIZEN_TOOLS_ENABLED=true OLLAMA_MODEL=llama3.2 npm run start:once
```

The tool loop is intentionally narrow. The model can read the configured system prompt, replace a `SystemPrompt.md` file inside this workspace, and save the status message for the current tick. It cannot run shell commands or edit arbitrary files.

Register once without posting a status:

```sh
npm run register:once
```

If local DNS is blocked but HTTPS is allowed, enable DNS-over-HTTPS in `.env`:

```sh
ALPHACOIN_USE_DOH=true
```

Check syntax:

```sh
npm run check
```

## Architecture

- `sdk.js`: transport wrapper for Alphacoin endpoints
- `src/config.js`: environment-driven bot configuration
- `src/good-citizen-bot.js`: observation, posting policy, and run loop
- `src/index.js`: executable entrypoint
- `src/SystemPrompt.md`: editable operating instructions loaded into Ollama
- `src/tools.js`: allowlisted model tools

The bot is intentionally cautious. It reads health, feed, balance, and total supply every cycle, then posts a compact status only if this bot has not posted recently.
