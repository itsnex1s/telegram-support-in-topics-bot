function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requiredNegativeInt(name: string): number {
  const raw = required(name).trim();
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  if (value >= 0) {
    throw new Error(`${name} must be a negative integer (Telegram supergroup id), got: ${raw}`);
  }
  return value;
}

export const config = {
  SUPPORT_BOT_TOKEN: required('SUPPORT_BOT_TOKEN'),
  SUPPORT_STAFF_GROUP_ID: requiredNegativeInt('SUPPORT_STAFF_GROUP_ID'),
  SUPPORT_STORE_PATH: (process.env.SUPPORT_STORE_PATH ?? './data/topics.json').trim(),
};
