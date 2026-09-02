import { Bot, GrammyError } from 'grammy';
import { config } from './config.js';
import * as store from './store.js';

const staffGroupId = config.SUPPORT_STAFF_GROUP_ID;
const MAX_TOPIC_NAME = 128;

function userDisplayName(from: { first_name: string; last_name?: string; username?: string }): string {
  const name = from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name;
  return from.username ? `${name} (@${from.username})` : name;
}

function topicName(from: { first_name: string; last_name?: string; username?: string }): string {
  const display = userDisplayName(from);
  return display.length <= MAX_TOPIC_NAME ? display : display.slice(0, MAX_TOPIC_NAME - 1) + '…';
}

async function notifyUser(bot: Bot, userId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(userId, text);
  } catch {
    // User may have blocked the bot — nothing we can do.
  }
}

export function isTopicClosed(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes('TOPIC_CLOSED');
}

export async function forwardWithAutoReopen(params: {
  topicId: number;
  sendToTopic: (topicId: number) => Promise<void>;
  reopenTopic: (topicId: number) => Promise<void>;
}): Promise<void> {
  try {
    await params.sendToTopic(params.topicId);
  } catch (err) {
    if (!isTopicClosed(err)) throw err;
    await params.reopenTopic(params.topicId);
    await params.sendToTopic(params.topicId);
  }
}

export function registerHandlers(bot: Bot): void {
  // /start in private chat
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply('Hello! Send your question and we will get back to you as soon as possible.');
  });

  // Operator commands inside forum topics
  bot.command('close', async (ctx, next) => {
    if (ctx.chat.id !== staffGroupId || !ctx.msg.message_thread_id) return next();
    const topicId = ctx.msg.message_thread_id;
    const userId = store.getUserId(topicId);
    try {
      await bot.api.closeForumTopic(staffGroupId, topicId);
    } catch {
      // topic may already be closed
    }
    if (userId) {
      await notifyUser(bot, userId, 'Your ticket has been closed. If you have more questions, just send a new message.');
    }
  });

  bot.command('reopen', async (ctx, next) => {
    if (ctx.chat.id !== staffGroupId || !ctx.msg.message_thread_id) return next();
    try {
      await bot.api.reopenForumTopic(staffGroupId, ctx.msg.message_thread_id);
    } catch {
      // topic may already be open
    }
  });

  bot.command('ban', async (ctx, next) => {
    if (ctx.chat.id !== staffGroupId || !ctx.msg.message_thread_id) return next();
    const topicId = ctx.msg.message_thread_id;
    const userId = store.getUserId(topicId);
    if (!userId) {
      await ctx.reply('Could not find a user for this topic.');
      return;
    }
    store.ban(userId);
    try {
      await bot.api.closeForumTopic(staffGroupId, topicId);
    } catch {
      // topic may already be closed
    }
    await notifyUser(bot, userId, 'You have been blocked from support.');
    await ctx.reply(`User ${userId} has been banned.`);
  });

  bot.command('unban', async (ctx, next) => {
    if (ctx.chat.id !== staffGroupId || !ctx.msg.message_thread_id) return next();
    const userId = store.getUserId(ctx.msg.message_thread_id);
    if (!userId) {
      await ctx.reply('Could not find a user for this topic.');
      return;
    }
    if (!store.unban(userId)) {
      await ctx.reply('This user is not banned.');
      return;
    }
    await ctx.reply(`User ${userId} has been unbanned.`);
  });

  // User messages in private chat → forward to forum topic
  bot.on('message', async (ctx) => {
    // Private chat: user → topic
    if (ctx.chat.type === 'private') {
      const userId = ctx.from.id;

      if (store.isBanned(userId)) return;

      let topicId = store.getTopicId(userId);

      if (topicId === undefined) {
        // Create new forum topic
        const topic = await bot.api.createForumTopic(staffGroupId, topicName(ctx.from));
        topicId = topic.message_thread_id;
        store.setMapping(userId, topicId);

        // Send info message to the topic
        const info = [
          `New conversation`,
          `Name: ${userDisplayName(ctx.from)}`,
          `ID: ${userId}`,
          ctx.from.username ? `Username: @${ctx.from.username}` : null,
          `Date: ${new Date().toISOString()}`,
        ].filter(Boolean).join('\n');
        await bot.api.sendMessage(staffGroupId, info, { message_thread_id: topicId });
      }

      await forwardWithAutoReopen({
        topicId,
        sendToTopic: async (threadId) => {
          await ctx.forwardMessage(staffGroupId, { message_thread_id: threadId });
        },
        reopenTopic: async (threadId) => {
          await bot.api.reopenForumTopic(staffGroupId, threadId);
        },
      });
      return;
    }

    // Staff group: operator reply → user
    if (ctx.chat.id === staffGroupId && ctx.msg.message_thread_id) {
      // Ignore service messages
      if (ctx.msg.forum_topic_created || ctx.msg.forum_topic_closed || ctx.msg.forum_topic_reopened || ctx.msg.forum_topic_edited) return;
      // Ignore bot's own messages
      if (ctx.from?.id === bot.botInfo.id) return;
      // Ignore commands (already handled above)
      if (ctx.msg.text?.startsWith('/')) return;

      const userId = store.getUserId(ctx.msg.message_thread_id);
      if (!userId) return;

      await ctx.copyMessage(userId);
    }
  });
}
