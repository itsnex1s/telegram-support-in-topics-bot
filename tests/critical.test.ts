import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GrammyError } from 'grammy';

function moduleUrl(relPath: string): string {
  const abs = join(process.cwd(), relPath);
  return `${pathToFileURL(abs).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function importConfigWith(staffGroupId: string) {
  process.env.SUPPORT_BOT_TOKEN = 'test-token';
  process.env.SUPPORT_STAFF_GROUP_ID = staffGroupId;
  return await import(moduleUrl('src/config.ts'));
}

function runStoreLoad(storePath: string): { status: number | null; stderr: string } {
  const proc = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      "import('./src/store.ts').then((m)=>m.load()).catch((e)=>{console.error(String(e?.message ?? e)); process.exit(1);})",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SUPPORT_BOT_TOKEN: 'test-token',
        SUPPORT_STAFF_GROUP_ID: '-100123456789',
        SUPPORT_STORE_PATH: storePath,
      },
      encoding: 'utf8',
    }
  );
  return { status: proc.status, stderr: proc.stderr };
}

test('config: invalid SUPPORT_STAFF_GROUP_ID fails fast', async () => {
  await assert.rejects(async () => {
    await importConfigWith('abc');
  }, /must be an integer/);
});

test('store.load: ENOENT starts fresh, corrupted JSON fails fast', async () => {
  const root = mkdtempSync(join(tmpdir(), 'support-bot-store-'));
  const missingPath = join(root, 'missing', 'topics.json');

  const missing = runStoreLoad(missingPath);
  assert.equal(missing.status, 0, `Expected ENOENT load to pass, got stderr=${missing.stderr}`);

  const brokenPath = join(root, 'broken', 'topics.json');
  mkdirSync(join(root, 'broken'), { recursive: true });
  writeFileSync(brokenPath, '{"topics":[', 'utf8');

  const broken = runStoreLoad(brokenPath);
  assert.notEqual(broken.status, 0, 'Expected corrupted store to fail');
  assert.match(broken.stderr, /Failed to load store/);
});

function apiError(description: string): GrammyError {
  return new GrammyError('Call to forwardMessage failed!', { ok: false, error_code: 400, description }, 'forwardMessage', {});
}

test('handlers: deliverToTopic reopens on TOPIC_CLOSED, recreates on a missing thread, rethrows the rest', async () => {
  process.env.SUPPORT_BOT_TOKEN = 'test-token';
  process.env.SUPPORT_STAFF_GROUP_ID = '-100123456789';
  const mod = await import(moduleUrl('src/handlers.ts'));

  // The first send fails with the given description; later sends succeed.
  async function run(failWith: string): Promise<string[]> {
    const log: string[] = [];
    let first = true;
    await mod.deliverToTopic({
      topicId: 42,
      send: async (topicId: number) => {
        log.push(`send:${topicId}`);
        if (first) {
          first = false;
          throw apiError(failWith);
        }
      },
      reopen: async (topicId: number) => {
        log.push(`reopen:${topicId}`);
      },
      recreate: async () => {
        log.push('recreate');
        return 43;
      },
    });
    return log;
  }

  assert.deepEqual(await run('Bad Request: TOPIC_CLOSED'), ['send:42', 'reopen:42', 'send:42']);
  assert.deepEqual(await run('Bad Request: message thread not found'), ['send:42', 'recreate', 'send:43']);
  await assert.rejects(run('Bad Request: not enough rights'), /not enough rights/);
});

test('bot: API call is repeated once after a 429 with retry_after', async () => {
  process.env.SUPPORT_BOT_TOKEN = 'test-token';
  process.env.SUPPORT_STAFF_GROUP_ID = '-100123456789';
  const mod = await import(moduleUrl('src/bot.ts'));

  let attempts = 0;
  const flooded = async () =>
    ++attempts === 1
      ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 0 } }
      : { ok: true, result: true };
  const res = await mod.retryAfterFlood(flooded, 'sendMessage', { chat_id: 1, text: 'hi' });
  assert.equal(attempts, 2);
  assert.equal(res.ok, true);

  attempts = 0;
  const denied = async () => {
    attempts += 1;
    return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' };
  };
  assert.equal((await mod.retryAfterFlood(denied, 'sendMessage', {})).ok, false);
  assert.equal(attempts, 1, 'other errors are not retried');
});
