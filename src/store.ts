import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

interface StoreData {
  topics: Array<{ userId: number; topicId: number }>;
  banned: number[];
}

const userIdToTopicId = new Map<number, number>();
const topicIdToUserId = new Map<number, number>();
const bannedUserIds = new Set<number>();

function persist(): void {
  const data: StoreData = {
    topics: Array.from(userIdToTopicId.entries()).map(([userId, topicId]) => ({ userId, topicId })),
    banned: Array.from(bannedUserIds),
  };
  mkdirSync(dirname(config.SUPPORT_STORE_PATH), { recursive: true });
  const tmpPath = `${config.SUPPORT_STORE_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, config.SUPPORT_STORE_PATH);
}

export function load(): void {
  try {
    const raw = readFileSync(config.SUPPORT_STORE_PATH, 'utf-8');
    const data: StoreData = JSON.parse(raw);
    if (!Array.isArray(data.topics) || !Array.isArray(data.banned)) {
      throw new Error('Store file has invalid shape');
    }
    for (const { userId, topicId } of data.topics) {
      userIdToTopicId.set(userId, topicId);
      topicIdToUserId.set(topicId, userId);
    }
    for (const id of data.banned) {
      bannedUserIds.add(id);
    }
    console.log(`Store loaded: ${userIdToTopicId.size} topics, ${bannedUserIds.size} banned`);
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      console.log('No existing store found, starting fresh');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load store: ${message}`);
  }
}

export function getTopicId(userId: number): number | undefined {
  return userIdToTopicId.get(userId);
}

export function getUserId(topicId: number): number | undefined {
  return topicIdToUserId.get(topicId);
}

export function setMapping(userId: number, topicId: number): void {
  userIdToTopicId.set(userId, topicId);
  topicIdToUserId.set(topicId, userId);
  persist();
}

export function isBanned(userId: number): boolean {
  return bannedUserIds.has(userId);
}

export function ban(userId: number): void {
  bannedUserIds.add(userId);
  persist();
}
