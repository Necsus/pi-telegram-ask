# Contributing

Thanks for helping improve `@necsus/pi-telegram-ask`.

## Before opening a change

- Use a focused branch from the latest `main`.
- Keep changes small and avoid unrelated refactors.
- Open an issue first for significant behavior, API, dependency, or security changes.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Never include Telegram bot tokens, credentials, private chat content, private source code, or personal `config.json` values in an issue, commit, test fixture, or pull request.

## Development

Requirements:

- Node.js 22.19 or newer
- npm 9 or newer

Install and validate:

```bash
npm install
npm test
npm run typecheck
npm run pack:check
```

Tests must not require Telegram credentials or make live Telegram requests. Add or update tests when behavior changes.

## Pull requests

Pull requests must:

- explain the problem and the chosen solution;
- pass all required CI checks;
- update documentation for user-visible changes;
- resolve review conversations;
- receive the required maintainer approval.

New commits invalidate previous approvals when reviewable code changes. Package publication and GitHub releases remain maintainer-only operations.
