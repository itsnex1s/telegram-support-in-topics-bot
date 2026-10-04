import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// staffGroupId and closed are missing in files written by version 1.1.0 and earlier.
interface StoreData {
  staffGroupId?: number;
  topics: Array<{ userId: number; topicId: number }>;
  closed?: number[];
  banned: number[];
}

const userIdToTopicId = new Map<number, number>();
const topicIdToUserId = new Map<number, number>();
const closedTopicIds = new Set<number>();
const bannedUserIds = new Set<number>();

function persist(): void {
  const data: StoreData = {
    staffGroupId: config.SUPPORT_STAFF_GROUP_ID,
    topics: Array.from(userIdToTopicId.entries()).map(([userId, topicId]) => ({ userId, topicId })),
    closed: Array.from(closedTopicIds),
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
    for (const id of data.banned) {
      bannedUserIds.add(id);
    }
    // Topic ids exist only in the group that created them: in another group the same ids may belong
    // to other users' topics. Bans hold for any group. A file without staffGroupId predates this
    // check, so it is taken as written for the configured group and stamped with it right away.
    if (data.staffGroupId !== undefined && data.staffGroupId !== config.SUPPORT_STAFF_GROUP_ID) {
      console.log(
        `Store was written for staff group ${data.staffGroupId}: dropped ${data.topics.length} topics, users will get new ones`
      );
    } else {
      for (const { userId, topicId } of data.topics) {
        userIdToTopicId.set(userId, topicId);
        topicIdToUserId.set(topicId, userId);
      }
      for (const id of data.closed ?? []) {
        closedTopicIds.add(id);
      }
      console.log(`Store loaded: ${userIdToTopicId.size} topics, ${bannedUserIds.size} banned`);
    }
    if (data.staffGroupId !== config.SUPPORT_STAFF_GROUP_ID) persist();
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
  const previous = userIdToTopicId.get(userId);
  if (previous !== undefined) {
    topicIdToUserId.delete(previous);
    closedTopicIds.delete(previous);
  }
  userIdToTopicId.set(userId, topicId);
  topicIdToUserId.set(topicId, userId);
  persist();
}

export function isClosed(topicId: number): boolean {
  return closedTopicIds.has(topicId);
}

// Only users' topics are tracked; other topics of the staff group are none of the bot's business.
export function setClosed(topicId: number, closed: boolean): void {
  if (!topicIdToUserId.has(topicId) || closedTopicIds.has(topicId) === closed) return;
  if (closed) closedTopicIds.add(topicId);
  else closedTopicIds.delete(topicId);
  persist();
}

export function isBanned(userId: number): boolean {
  return bannedUserIds.has(userId);
}

export function ban(userId: number): void {
  bannedUserIds.add(userId);
  persist();
}

export function unban(userId: number): boolean {
  const removed = bannedUserIds.delete(userId);
  if (removed) persist();
  return removed;
}
