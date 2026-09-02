import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import type { ApiResponse, Update } from 'grammy/types';

const STAFF_GROUP_ID = -100123456789;
const BOT_ID = 4242;

process.env.SUPPORT_BOT_TOKEN = 'test-token';
process.env.SUPPORT_STAFF_GROUP_ID = String(STAFF_GROUP_ID);
process.env.SUPPORT_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'support-bot-handlers-')), 'topics.json');

const { registerHandlers } = await import('../src/handlers.ts');
const store = await import('../src/store.ts');

type ApiCall = { method: string; payload: Record<string, unknown> };
type ApiReply = { ok: true; result: unknown } | { ok: false; error_code: number; description: string };
type Responder = (call: ApiCall) => ApiReply | undefined;

const OK_MESSAGE: ApiReply = { ok: true, result: { message_id: 1 } };

// Builds a bot whose API calls are recorded and answered by `respond` instead of Telegram.
function createTestBot(respond: Responder = () => undefined): { bot: Bot; calls: ApiCall[] } {
  const bot = new Bot('test-token', {
    botInfo: {
      id: BOT_ID,
      is_bot: true,
      first_name: 'Support',
      username: 'support_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    },
  });
  const calls: ApiCall[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    return (respond(call) ?? OK_MESSAGE) as ApiResponse<never>;
  });
  bot.catch((err) => {
    throw err.error;
  });
  registerHandlers(bot);
  return { bot, calls };
}

let updateId = 0;
let messageId = 0;

function userMessage(userId: number, fields: Record<string, unknown>): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: 0,
      chat: { id: userId, type: 'private', first_name: 'Ann' },
      from: { id: userId, is_bot: false, first_name: 'Ann', username: 'ann' },
      ...fields,
    },
  } as Update;
}

function topicMessage(topicId: number, fields: Record<string, unknown>): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: 0,
      chat: { id: STAFF_GROUP_ID, type: 'supergroup', title: 'Staff', is_forum: true },
      from: { id: 9001, is_bot: false, first_name: 'Operator' },
      message_thread_id: topicId,
      is_topic_message: true,
      ...fields,
    },
  } as Update;
}

function command(text: string): Record<string, unknown> {
  return { text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] };
}

function forumTopic(topicId: number): ApiReply {
  return { ok: true, result: { message_thread_id: topicId, name: 'topic', icon_color: 0 } };
}

function methods(calls: ApiCall[]): string[] {
  return calls.map((call) => call.method);
}

test('first message from a user creates a topic and forwards the message', async () => {
  const { bot, calls } = createTestBot(({ method }) => (method === 'createForumTopic' ? forumTopic(11) : undefined));
  await bot.handleUpdate(userMessage(1, { text: 'hi' }));
  assert.deepEqual(methods(calls), ['createForumTopic', 'sendMessage', 'forwardMessage']);
  assert.equal(calls[0].payload.name, 'Ann (@ann)');
  assert.equal(calls[2].payload.message_thread_id, 11);
  assert.equal(store.getUserId(11), 1);
});

test('operator commands typed by a user in private chat are forwarded', async () => {
  store.setMapping(2, 12);
  const { bot, calls } = createTestBot();
  await bot.handleUpdate(userMessage(2, command('/close')));
  assert.deepEqual(methods(calls), ['forwardMessage']);
  assert.equal(calls[0].payload.message_thread_id, 12);
});

test('/close inside a topic closes it and notifies the user', async () => {
  store.setMapping(3, 13);
  const { bot, calls } = createTestBot();
  await bot.handleUpdate(topicMessage(13, command('/close')));
  assert.deepEqual(methods(calls), ['closeForumTopic', 'sendMessage']);
  assert.equal(calls[0].payload.message_thread_id, 13);
  assert.equal(calls[1].payload.chat_id, 3);
});

test('closed topic is reopened before the message is forwarded', async () => {
  store.setMapping(4, 14);
  let forwards = 0;
  const { bot, calls } = createTestBot(({ method }) =>
    method === 'forwardMessage' && ++forwards === 1
      ? { ok: false, error_code: 400, description: 'Bad Request: TOPIC_CLOSED' }
      : undefined
  );
  await bot.handleUpdate(userMessage(4, { text: 'still there?' }));
  assert.deepEqual(methods(calls), ['forwardMessage', 'reopenForumTopic', 'forwardMessage']);
});

test('deleted topic is recreated and the message goes to the new one', async () => {
  store.setMapping(5, 15);
  const { bot, calls } = createTestBot(({ method, payload }) => {
    if (method === 'forwardMessage' && payload.message_thread_id === 15) {
      return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };
    }
    return method === 'createForumTopic' ? forumTopic(16) : undefined;
  });
  await bot.handleUpdate(userMessage(5, { text: 'hello?' }));
  assert.deepEqual(methods(calls), ['forwardMessage', 'createForumTopic', 'sendMessage', 'forwardMessage']);
  assert.equal(calls[3].payload.message_thread_id, 16);
  assert.equal(store.getTopicId(5), 16);
  assert.equal(store.getUserId(16), 5);
  assert.equal(store.getUserId(15), undefined, 'stale topic mapping must be dropped');
});

test('operator reply is copied to the user', async () => {
  store.setMapping(6, 17);
  const { bot, calls } = createTestBot();
  await bot.handleUpdate(topicMessage(17, { text: 'Hello from support' }));
  assert.deepEqual(methods(calls), ['copyMessage']);
  assert.equal(calls[0].payload.chat_id, 6);
});

test('operator is told when the reply could not be delivered', async () => {
  store.setMapping(7, 18);
  const { bot, calls } = createTestBot(({ method }) =>
    method === 'copyMessage' ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } : undefined
  );
  const update = topicMessage(18, { text: 'Are you there?' });
  await bot.handleUpdate(update);
  assert.deepEqual(methods(calls), ['copyMessage', 'sendMessage']);
  const notice = calls[1].payload;
  assert.equal(notice.chat_id, STAFF_GROUP_ID);
  assert.equal(notice.message_thread_id, 18);
  assert.match(String(notice.text), /blocked by the user/);
  assert.deepEqual(notice.reply_parameters, { message_id: update.message?.message_id });
});

test('user is told when their message could not be delivered', async () => {
  store.setMapping(8, 19);
  const { bot, calls } = createTestBot(({ method }) =>
    method === 'forwardMessage' ? { ok: false, error_code: 400, description: 'Bad Request: not enough rights' } : undefined
  );
  await assert.rejects(bot.handleUpdate(userMessage(8, { text: 'x' })), /not enough rights/);
  assert.deepEqual(methods(calls), ['forwardMessage', 'sendMessage']);
  assert.equal(calls[1].payload.chat_id, 8);
});
