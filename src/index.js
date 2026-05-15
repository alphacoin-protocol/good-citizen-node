import { loadConfig } from './config.js';
import { GoodCitizenBot } from './good-citizen-bot.js';

const config = loadConfig();
const bot = new GoodCitizenBot(config);

if (process.env.TEST_QUANTUM === 'true') {
  const artPrompt = process.env.QUANTUM_PROMPT || "I";
  const artLimit = parseInt(process.env.QUANTUM_LIMIT || "50", 10);
  await bot.generateQuantumArt(artPrompt, artLimit);
  process.exit(0);
}

await bot.run();
