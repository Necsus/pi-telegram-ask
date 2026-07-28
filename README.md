# @necsus/pi-telegram-ask

Pause a [Pi coding agent](https://pi.dev) workflow when a developer decision is required, send the question to Telegram, and resume with the authorized developer's answer. Telegram can be toggled off at any time to restore Pi's local questionnaire.

## Features

- Blocks the current tool call until the developer answers, cancels, or aborts the Pi turn.
- Sends optional proposed answers as Telegram inline buttons.
- Supports free-form replies and multi-select questions.
- Restricts answers to one configured Telegram user ID.
- Keeps source files, conversation history, option previews, and reasoning out of Telegram.
- Persists `/telegram-ask on|off|status` mode changes without reloading Pi.
- Reuses the local `@juicesharp/rpiv-ask-user-question` interface when Telegram is off.
- Marks compatible Herdr integrations as blocked while awaiting a human response.

## Install

Until the npm package is published, install directly from GitHub:

```text
pi install git:github.com/Necsus/pi-telegram-ask
```

After npm publication:

```text
pi install npm:@necsus/pi-telegram-ask
```

Restart Pi after installation.

> Remove or disable another package that registers `ask_user_question`; Pi keeps the first tool registration for a duplicate name.

## Telegram setup

1. Create a bot with Telegram's verified `@BotFather` account.
2. Open a private conversation with the new bot and send `/start`.
3. Find your numeric Telegram user ID and chat ID. In a private conversation they are normally identical.
4. Copy `config.example.json` to:

```text
${XDG_CONFIG_HOME:-~/.config}/pi-telegram-ask/config.json
```

Example:

```json
{
  "mode": "local",
  "chatId": "123456789",
  "userId": "123456789",
  "pollTimeoutSeconds": 45
}
```

For a forum group topic, use the group's negative `chatId`, keep `userId` set to the only developer allowed to answer, and add its positive `threadId`.

`pollTimeoutSeconds` controls each Telegram long-poll request. It is not an overall questionnaire timeout; the workflow waits until an answer, cancellation, or Pi abort.

## Bot token

Never put the bot token in the repository or `config.json`.

### macOS Keychain

Store it as a generic password:

- service: `pi-agent-telegram`
- account: your macOS `$USER`
- password: the BotFather token

The non-secret configuration can override `keychainService` and `keychainAccount` when needed.

### Environment

Alternatively, set `PI_TELEGRAM_BOT_TOKEN` in the environment that launches Pi. These non-secret settings can also be provided through environment variables:

- `PI_TELEGRAM_CHAT_ID`
- `PI_TELEGRAM_USER_ID`
- `PI_TELEGRAM_THREAD_ID`
- `PI_TELEGRAM_ASK_CONFIG`

## Usage

```text
/telegram-ask on      # send developer questions to Telegram
/telegram-ask off     # use Pi's local questionnaire
/telegram-ask status  # show the active channel
```

The older `telegram` and `local` values remain accepted as compatibility aliases. `/telegram-ask-status` is also available as a status alias.

When Telegram is on, answer with an inline button or reply directly to the bot's question. Cancel with the inline cancel button, `/cancel`, or Esc in Pi.

When Telegram is off, questions with 2-4 options use the original tabbed Pi questionnaire. Questions without proposed answers use Pi's native text-input dialog.

## Privacy and limitations

- Telegram bot conversations are not end-to-end encrypted.
- Only project directory name, question text, labels, and descriptions are sent.
- Use a dedicated bot. Telegram allows only one active `getUpdates` consumer per bot, so simultaneous Pi processes must not share one bot.
- This tool is intended for clarification and developer decisions, not remote approval of destructive commands.
- Permission, authentication, billing, and deployment approvals should remain in a separately controlled workflow.

## Development

Requirements: Node.js 22.19 or newer.

```bash
npm install
npm test
npm run typecheck
npm run pack:check
```

Test the package in Pi without installing it globally:

```bash
pi -e .
```

## Dependency attribution

Local questionnaire behavior is provided by [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question), used under its MIT license and bundled for reliable Pi package installation.

## License

MIT
