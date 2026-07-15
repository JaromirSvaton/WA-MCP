# wa-mcp - WhatsApp MCP server for Claude Desktop

Lets Claude read and send WhatsApp messages (DMs and groups) through your own
WhatsApp account. Uses [Baileys](https://github.com/WhiskeySockets/Baileys)
(direct WebSocket, no browser) and stores messages locally in SQLite.

## Setup (3 steps)

```powershell
# 1. Install + build + show the Claude Desktop config for your machine
npm run setup

# 2. Link your WhatsApp (one time only) - scan the QR with your phone:
#    WhatsApp > Settings > Linked Devices > Link a Device
npm run login

# 3. Paste the config printed by step 1 into:
#    %APPDATA%\Claude\claude_desktop_config.json
#    then fully restart Claude Desktop (quit from system tray, reopen).
```

If the QR code looks garbled in your terminal, run `chcp 65001` first or use
Windows Terminal.

## Tools exposed to Claude

| Tool | What it does |
|---|---|
| `list_chats` | Recent chats (DMs + groups) with JIDs and previews |
| `read_messages` | Message history of a chat, with paging |
| `search_messages` | Full-text search across all stored messages |
| `search_contacts` | Find a contact's JID by name or number |
| `send_message` | Send text to a phone number or group JID |
| `list_group_participants` | Members of a group |
| `get_connection_status` | Troubleshooting |

## How it works

- All data lives in `~/.wa-mcp/` (session keys in `auth/`, messages in
  `messages.db`). **Treat `auth/` like a private key** - anyone with those
  files can hijack your WhatsApp session.
- Messages are ingested into SQLite while the server runs (Claude Desktop
  keeps it running in the background). History from before the first login is
  only partially available - WhatsApp sends a limited recent-history sync.
- Claude Desktop asks for your approval before every `send_message` call.

## Commands

| Command | Purpose |
|---|---|
| `npm run setup` | Install, build, print Claude Desktop config |
| `npm run login` | Link WhatsApp via QR (one time) |
| `npm run logout` | Wipe the local session |
| `npm run build` | Recompile after code changes |

## Troubleshooting

- **"Not logged in"** - run `npm run login`, then restart Claude Desktop.
- **Server not showing in Claude** - check the config file is valid JSON and
  paths are absolute; view logs at `%APPDATA%\Claude\logs\mcp*.log`.
- **Logged out randomly** - WhatsApp occasionally drops linked devices; run
  `npm run login` again.
- **Ban risk** - this uses an unofficial API. Keep usage personal and
  low-volume; don't send bulk/automated spam.
