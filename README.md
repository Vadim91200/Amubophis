# Meteora Position Monitor Bot

A Telegram bot that monitors Meteora positions and sends notifications when they go out of range.

## Features

- Monitors Meteora positions every 10 minutes
- Sends Telegram notifications when positions go out of range
- Notifies when positions return to range
- Provides current status of all positions via Telegram commands
- Graceful shutdown handling

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following variables:
```
PRIVATE_KEY=your_solana_private_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

To get a Telegram bot token:
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Use the `/newbot` command to create a new bot
3. Follow the instructions to get your bot token

To get your Telegram chat ID:
1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. The bot will reply with your chat ID

## Usage

Start the bot:
```bash
npm start
```

### Telegram Commands

- `/start` - Start the bot and get a welcome message
- `/status` - Get the current status of all positions

## How it Works

The bot monitors your Meteora positions every 10 minutes and checks if they are in range. When a position goes out of range, you'll receive a notification with:
- Position public key
- Current bin ID
- Position range (lower and upper bins)
- How far the position is from the current range
- Total X and Y amounts

You'll also receive a notification when a position returns to range.

## Error Handling

The bot includes error handling for:
- Connection issues
- Position monitoring errors
- Graceful shutdown on SIGINT and SIGTERM signals

## Development

To build the TypeScript code:
```bash
npm run build
```

The compiled JavaScript will be in the `dist` directory. 