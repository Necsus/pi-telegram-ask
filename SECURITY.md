# Security

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not include bot tokens, credentials, private chat content, or private source code in public issues.

## Credential handling

- Never commit a Telegram bot token or place it in `config.json`.
- On macOS, store the token as a generic Keychain password under service `pi-agent-telegram`.
- Elsewhere, provide `PI_TELEGRAM_BOT_TOKEN` through a trusted process environment.
- If a token is exposed, revoke it immediately with Telegram's `@BotFather` and issue a replacement.

## Trust model

Telegram Bot API conversations are not end-to-end encrypted. The extension sends only the project directory name, authored question, option labels, and option descriptions. It does not send project files, conversation history, option previews, or model reasoning.

Only the configured Telegram `userId` can answer. A dedicated bot is recommended because Telegram permits only one active `getUpdates` consumer per bot.
