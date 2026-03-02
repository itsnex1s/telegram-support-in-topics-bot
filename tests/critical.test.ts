import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

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

test('handlers: forwardWithAutoReopen retries send after reopen', async () => {
  process.env.SUPPORT_BOT_TOKEN = 'test-token';
  process.env.SUPPORT_STAFF_GROUP_ID = '-100123456789';
  const mod = await import(moduleUrl('src/handlers.ts'));

  let sends = 0;
  let reopens = 0;
  await mod.forwardWithAutoReopen({
    topicId: 42,
    sendToTopic: async () => {
      sends += 1;
      if (sends === 1) throw new Error('topic closed');
    },
    reopenTopic: async () => {
      reopens += 1;
    },
  });

  assert.equal(sends, 2);
  assert.equal(reopens, 1);
});
