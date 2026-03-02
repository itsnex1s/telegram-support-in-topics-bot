import { Bot } from 'grammy';
import { config } from './config.js';
import { registerHandlers } from './handlers.js';

export function createBot(): Bot {
  const bot = new Bot(config.SUPPORT_BOT_TOKEN);
  registerHandlers(bot);
  bot.catch((err) => {
    console.error('Bot error:', err.message);
  });
  return bot;
}
