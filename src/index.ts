import { createBot } from './bot.js';
import * as store from './store.js';

const bot = createBot();
store.load();

bot.start({ onStart: () => console.log('Support bot started') }).catch((err) => {
  console.error('Bot stopped with error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

process.on('SIGTERM', () => bot.stop());
process.on('SIGINT', () => bot.stop());
