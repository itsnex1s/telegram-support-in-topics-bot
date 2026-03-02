import { createBot } from './bot.js';
import * as store from './store.js';

const bot = createBot();
store.load();

bot.start({ onStart: () => console.log('Support bot started') });

process.on('SIGTERM', () => bot.stop());
process.on('SIGINT', () => bot.stop());
