<p align="center">
  <img src="assets/logo.png" width="128" height="128" alt="Support Bot logo">
</p>

<h1 align="center">Telegram Support Bot</h1>

<p align="center">
  Minimal Telegram support bot that turns a forum group into a helpdesk.<br>
  User sends a DM → bot creates a forum topic → operator replies in the topic → reply goes back to the user.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#setup">Setup</a> •
  <a href="#commands">Commands</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#license">License</a>
</p>

---

## Features

- One dependency — [grammY](https://grammy.dev)
- Polling mode — no webhook, no HTTP server needed
- JSON file persistence — no database required
- Auto-reopens closed topics when users send new messages
- Operator commands: close, reopen, ban

## How it works

1. User sends a message to the bot in a private chat
2. Bot creates a **Forum Topic** in the staff group with the user's name
3. Message is forwarded to the newly created topic
4. Operator replies inside the topic
5. Bot copies the reply back to the user (without "forwarded from" label)
6. Subsequent messages from the same user go to the same topic

## Setup

### 1. Create a bot

Create a bot via [@BotFather](https://t.me/BotFather) and save the token.

### 2. Create a forum group

1. Create a group in Telegram
2. Convert it to a supergroup (Settings → Chat History → Visible)
3. Enable Topics (Settings → Topics)
4. Add the bot to the group and make it an admin with permissions:
   - Manage Topics
   - Send Messages
   - Delete Messages

### 3. Get the group ID

Add [@getmyid_bot](https://t.me/getmyid_bot) to the group or forward a message from the group — it will show the chat ID (a negative number like `-100123456789`).

### 4. Configure environment

```bash
cp .env.example .env
```

```env
SUPPORT_BOT_TOKEN=123456:ABC-DEF...         # required
SUPPORT_STAFF_GROUP_ID=-100123456789         # required
SUPPORT_STORE_PATH=./data/topics.json        # optional, default
```

### 5. Install and run

```bash
npm install

# Development (hot-reload)
npm run dev

# Production
npm run build
npm start
```

## Commands

### User commands (private chat)

| Command  | Description         |
| -------- | ------------------- |
| `/start` | Welcome message     |

### Operator commands (inside a forum topic)

| Command   | Description                          |
| --------- | ------------------------------------ |
| `/close`  | Close the ticket, notify the user    |
| `/reopen` | Reopen a closed ticket               |
| `/ban`    | Ban the user and close the ticket    |

## Architecture

```
src/
  index.ts      — Entry point: polling + graceful shutdown
  config.ts     — Environment variables with fail-fast validation
  bot.ts        — createBot() factory
  handlers.ts   — Message and command handlers
  store.ts      — In-memory store with JSON file persistence
```

- **No database** — user-to-topic mappings are stored in memory and persisted to a JSON file using atomic writes (write to temp file, then rename)
- **No webhook** — uses long polling, works behind NAT/firewalls without extra setup
- **Single dependency** — only [grammY](https://grammy.dev) for the Telegram Bot API

## Testing

```bash
npm test
```

Tests use Node.js built-in test runner — no extra test framework needed.

## License

[MIT](LICENSE)
