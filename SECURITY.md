# Access and credentials

Control messages are accepted only from `QQBOT_ALLOWED_USERS` or locally approved pairing grants. These are bot-scoped sender IDs, not QQ numbers. If both sources are empty, all control messages are denied. Pairing uses a random code with a five-minute lifetime and requires explicit confirmation in the local terminal. Merely sending the code does not grant access. Only one candidate is accepted per code; replay and expired requests are rejected.

Pairing grants live under `data/pairing/<AppID>/users.json` (or the configured data directory), separate from conversation state. `npm run pair -- revoke <senderId>` revokes a pairing grant immediately. Static `.env` grants must be removed separately and the bot restarted. Revoking control access does not cancel tasks or message subscriptions already established by that user; cancel those subscriptions in QQ beforehand if needed. Protect the configuration and data directories with the operating-system account's file permissions.

The bot can read files and run coding tasks with the operating-system privileges of its account. Claude `bypassPermissions` explicitly enables unattended tool execution. Keep the allowlist limited to trusted operators. Use a dedicated operating-system account if other users share the computer.

Never publish `.env`, `data/`, authentication files, attachments, logs or deployment backups. `npm run export:source` copies only the source allowlist to a new directory. Inspect the exported directory before publishing.

Installed deployments keep credentials in `%LOCALAPPDATA%/QQAgentBot/config/.env` and runtime state in the adjacent `data` directory. Release packages contain compiled code and public configuration templates only; the installer downloads production dependencies from npm and, when needed, a private Node.js runtime from nodejs.org. Program updates do not overwrite configuration or data.

Agent setup accepts secrets through a local JSON file, never command-line flags. Treat that input file as a credential file too. Machine-readable pairing still requires a local approval command with the exact request and sender IDs; the agent must obtain the operator's identity confirmation before invoking it. Diagnostic success, QQ gateway connection and control authorization are reported separately.

Project source is distributed under the MIT license in `LICENSE`. Dependencies retain their own licenses and service terms.
