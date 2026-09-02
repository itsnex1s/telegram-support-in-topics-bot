import { Bot, type Transformer } from 'grammy';
import { config } from './config.js';
import { registerHandlers } from './handlers.js';

const MAX_RETRY_AFTER_SECONDS = 60;

// Telegram answers 429 with retry_after when the bot sends too fast: wait that long and repeat the call once.
export const retryAfterFlood: Transformer = async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal);
  if (res.ok || res.error_code !== 429) return res;
  const seconds = res.parameters?.retry_after ?? 1;
  if (seconds > MAX_RETRY_AFTER_SECONDS) return res;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return prev(method, payload, signal);
};

export function createBot(): Bot {
  const bot = new Bot(config.SUPPORT_BOT_TOKEN);
  bot.api.config.use(retryAfterFlood);
  registerHandlers(bot);
  bot.catch((err) => {
    console.error('Bot error:', err.message);
  });
  return bot;
}
