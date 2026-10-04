import { Bot, GrammyError } from 'grammy';
import type { User } from 'grammy/types';
import { config } from './config.js';
import * as store from './store.js';

const staffGroupId = config.SUPPORT_STAFF_GROUP_ID;
const MAX_TOPIC_NAME = 128;

// Message kinds copyMessage can deliver. Service, invoice, giveaway and paid-media messages cannot be copied.
const COPYABLE_FIELDS = [
  'text', 'rich_message', 'animation', 'audio', 'document', 'live_photo', 'photo', 'sticker', 'story', 'video',
  'video_note', 'voice', 'contact', 'dice', 'game', 'poll', 'venue', 'location', 'checklist',
];
// forwardMessage takes those four kinds as well; only service messages cannot be forwarded.
const FORWARDABLE_FIELDS = [...COPYABLE_FIELDS, 'invoice', 'giveaway', 'giveaway_winners', 'paid_media'];

function userDisplayName(from: User): string {
  const name = from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name;
  return from.username ? `${name} (@${from.username})` : name;
}

function topicName(from: User): string {
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

// Telegram answers "message thread not found" when an operator deleted the topic.
export function isTopicGone(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes('message thread not found');
}

export async function deliverToTopic(params: {
  topicId: number;
  closed: boolean;
  send: (topicId: number) => Promise<void>;
  reopen: (topicId: number) => Promise<void>;
  recreate: () => Promise<number>;
}): Promise<void> {
  // The bot created the topic, so Telegram lets it post there even while the topic is closed
  // instead of answering TOPIC_CLOSED: reopen a topic known to be closed before sending.
  if (params.closed) {
    try {
      await params.reopen(params.topicId);
    } catch {
      // already open or deleted: the send below sorts that out
    }
  }
  try {
    await params.send(params.topicId);
  } catch (err) {
    if (isTopicClosed(err)) {
      await params.reopen(params.topicId);
      await params.send(params.topicId);
    } else if (isTopicGone(err)) {
      await params.send(await params.recreate());
    } else {
      throw err;
    }
  }
}

// Creates a forum topic for the user, stores the mapping and posts the user info card.
async function openTopic(bot: Bot, from: User): Promise<number> {
  const topic = await bot.api.createForumTopic(staffGroupId, topicName(from));
  const topicId = topic.message_thread_id;
  store.setMapping(from.id, topicId);

  const info = [
    `New conversation`,
    `Name: ${userDisplayName(from)}`,
    `ID: ${from.id}`,
    from.username ? `Username: @${from.username}` : null,
    `Date: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');
  await bot.api.sendMessage(staffGroupId, info, { message_thread_id: topicId });
  return topicId;
}

export function registerHandlers(bot: Bot): void {
  // /start in private chat
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private' || (ctx.from && store.isBanned(ctx.from.id))) return;
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
    store.setClosed(topicId, true);
    if (userId) {
      await notifyUser(bot, userId, 'Your ticket has been closed. If you have more questions, just send a new message.');
    }
  });

  bot.command('reopen', async (ctx, next) => {
    if (ctx.chat.id !== staffGroupId || !ctx.msg.message_thread_id) return next();
    const topicId = ctx.msg.message_thread_id;
    try {
      await bot.api.reopenForumTopic(staffGroupId, topicId);
    } catch {
      // topic may already be open
    }
    store.setClosed(topicId, false);
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
    store.setClosed(topicId, true);
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
      // Pins, auto-delete timer changes and other service messages cannot be forwarded
      if (!FORWARDABLE_FIELDS.some((field) => field in ctx.msg)) return;

      try {
        const topicId = store.getTopicId(userId) ?? (await openTopic(bot, ctx.from));
        await deliverToTopic({
          topicId,
          closed: store.isClosed(topicId),
          send: async (threadId) => {
            await ctx.forwardMessage(staffGroupId, { message_thread_id: threadId });
          },
          reopen: async (threadId) => {
            store.setClosed(threadId, false);
            await bot.api.reopenForumTopic(staffGroupId, threadId);
          },
          recreate: () => openTopic(bot, ctx.from),
        });
      } catch (err) {
        await notifyUser(bot, userId, 'Sorry, your message could not be delivered. Please try again later.');
        throw err;
      }
      return;
    }

    // Staff group: operator reply → user
    if (ctx.chat.id === staffGroupId && ctx.msg.message_thread_id) {
      // Operators can also close and reopen topics from the Telegram UI
      if (ctx.msg.forum_topic_closed) store.setClosed(ctx.msg.message_thread_id, true);
      if (ctx.msg.forum_topic_reopened) store.setClosed(ctx.msg.message_thread_id, false);
      // Skip service messages and other content copyMessage cannot deliver
      if (!COPYABLE_FIELDS.some((field) => field in ctx.msg)) return;
      // Ignore bot's own messages
      if (ctx.from?.id === bot.botInfo.id) return;
      // Ignore commands (already handled above)
      if (ctx.msg.text?.startsWith('/')) return;

      const userId = store.getUserId(ctx.msg.message_thread_id);
      if (!userId) return;

      try {
        await ctx.copyMessage(userId);
      } catch (err) {
        const reason = err instanceof GrammyError ? err.description : String(err);
        await ctx.reply(`⚠️ Not delivered: ${reason}`, { reply_parameters: { message_id: ctx.msg.message_id } });
      }
    }
  });
}
