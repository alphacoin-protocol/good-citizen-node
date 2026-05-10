import { loadConfig } from './config.js';
import { GoodCitizenBot } from './good-citizen-bot.js';

const config = loadConfig();
const bot = new GoodCitizenBot(config);

await bot.run();
