/**
 * WhatsApp MCP server for Claude Desktop.
 * Transport: stdio. NEVER write to stdout - JSON-RPC only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, type MessageRow } from "./store.js";
import { WhatsAppClient, hasSavedSession, normalizeRecipient } from "./whatsapp.js";
import { ensureDataDirs } from "./config.js";
import { log } from "./logger.js";

ensureDataDirs();

const store = new Store();
const client = new WhatsAppClient({ store });

const NOT_LOGGED_IN =
  "Not logged in to WhatsApp. Ask the user to run `npm run login` in the wa-mcp folder and scan the QR code, then restart Claude Desktop.";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function fmtTime(unixSeconds: number): string {
  if (!unixSeconds) return "?";
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function fmtMessage(m: MessageRow): string {
  const who = m.from_me ? "me" : m.sender_name || store.getContactName(m.sender_jid) || m.sender_jid;
  return `[${fmtTime(m.timestamp)}] ${who}: ${m.text}`;
}

async function ensureConnected(): Promise<string | null> {
  if (!hasSavedSession()) return NOT_LOGGED_IN;
  if (client.status === "connected") return null;
  const ok = await client.waitForConnection(20_000);
  if (client.status === "logged_out") return NOT_LOGGED_IN;
  return ok ? null : "WhatsApp connection is not ready yet (still connecting). Try again in a few seconds.";
}

const server = new McpServer({ name: "whatsapp", version: "1.0.0" });

server.registerTool(
  "list_chats",
  {
    title: "List WhatsApp chats",
    description:
      "List recent WhatsApp chats (DMs and groups), most recent first. Returns chat name, JID, and last message preview. Use the JID with other tools.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20).describe("Max number of chats to return"),
      query: z.string().optional().describe("Optional filter by chat/contact name or JID"),
    },
  },
  async ({ limit, query }) => {
    const chats = store.listChats(limit, query);
    if (chats.length === 0) {
      return text(
        hasSavedSession()
          ? "No chats in the local database yet. New messages are ingested while the server runs; history arrives after login."
          : NOT_LOGGED_IN
      );
    }
    const lines = chats.map((c) => {
      const name = c.name || c.contact_name || c.jid;
      const kind = c.is_group ? "group" : "dm";
      const preview = c.last_text ? ` | last: ${c.last_text.slice(0, 80)}` : "";
      return `${name} [${kind}] (${c.jid}) - ${fmtTime(c.last_message_time ?? 0)}${preview}`;
    });
    return text(lines.join("\n"));
  }
);

server.registerTool(
  "read_messages",
  {
    title: "Read WhatsApp messages",
    description:
      "Read recent messages from a chat (DM or group) in chronological order. Get the chat JID from list_chats or search_contacts.",
    inputSchema: {
      chat_jid: z.string().describe("Chat JID, e.g. 420777123456@s.whatsapp.net or 1234567890@g.us"),
      limit: z.number().int().min(1).max(200).default(50).describe("Max messages to return"),
      before_timestamp: z
        .number()
        .optional()
        .describe("Unix timestamp (seconds); only return messages older than this, for paging back"),
    },
  },
  async ({ chat_jid, limit, before_timestamp }) => {
    const messages = store.getMessages(chat_jid, limit, before_timestamp);
    if (messages.length === 0) return text(`No stored messages for ${chat_jid}.`);
    const name = store.getChatName(chat_jid);
    const header = `Chat: ${name ? `${name} (${chat_jid})` : chat_jid} - ${messages.length} message(s)\n`;
    return text(header + messages.map(fmtMessage).join("\n"));
  }
);

server.registerTool(
  "search_messages",
  {
    title: "Search WhatsApp messages",
    description: "Full-text search across stored WhatsApp messages, optionally within one chat.",
    inputSchema: {
      query: z.string().describe("Text to search for"),
      chat_jid: z.string().optional().describe("Optional: restrict search to this chat JID"),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ query, chat_jid, limit }) => {
    const messages = store.searchMessages(query, limit, chat_jid);
    if (messages.length === 0) return text(`No messages matching "${query}".`);
    const lines = messages.map((m) => {
      const chatName = store.getChatName(m.chat_jid) ?? m.chat_jid;
      return `${fmtMessage(m)}  (in ${chatName} | ${m.chat_jid})`;
    });
    return text(lines.join("\n"));
  }
);

server.registerTool(
  "search_contacts",
  {
    title: "Search WhatsApp contacts",
    description: "Find a contact by name or phone number and get their JID for messaging.",
    inputSchema: {
      query: z.string().describe("Name or phone number fragment"),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, limit }) => {
    const contacts = store.searchContacts(query, limit);
    if (contacts.length === 0) return text(`No contacts matching "${query}". Try list_chats with the query parameter.`);
    const lines = contacts.map((c) => `${c.name ?? c.chat_name ?? "?"} - ${c.jid}`);
    return text(lines.join("\n"));
  }
);

server.registerTool(
  "send_message",
  {
    title: "Send WhatsApp message",
    description:
      "Send a text message to a person or group. Recipient can be a phone number with country code (e.g. +420777123456) for DMs, or a JID (...@s.whatsapp.net for DMs, ...@g.us for groups).",
    inputSchema: {
      recipient: z.string().describe("Phone number or JID"),
      message: z.string().min(1).describe("Message text to send"),
    },
  },
  async ({ recipient, message }) => {
    const err = await ensureConnected();
    if (err) return errorText(err);
    try {
      const jid = normalizeRecipient(recipient);
      await client.sendText(jid, message);
      const name = store.getChatName(jid);
      return text(`Message sent to ${name ? `${name} (${jid})` : jid}.`);
    } catch (e) {
      return errorText(`Failed to send: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

server.registerTool(
  "list_group_participants",
  {
    title: "List group participants",
    description: "Get the participant list and subject of a WhatsApp group.",
    inputSchema: {
      group_jid: z.string().describe("Group JID ending in @g.us"),
    },
  },
  async ({ group_jid }) => {
    const err = await ensureConnected();
    if (err) return errorText(err);
    try {
      const meta = await client.getGroupMetadata(group_jid);
      const lines = meta.participants.map((p) => {
        const name = store.getContactName(p.id) ?? p.id;
        const role = p.admin ? ` (${p.admin})` : "";
        return `${name}${role} - ${p.id}`;
      });
      return text(`Group: ${meta.subject} (${meta.participants.length} members)\n` + lines.join("\n"));
    } catch (e) {
      return errorText(`Failed to fetch group: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

server.registerTool(
  "get_connection_status",
  {
    title: "WhatsApp connection status",
    description: "Check whether the WhatsApp connection is logged in and connected. Use for troubleshooting.",
    inputSchema: {},
  },
  async () => {
    return text(
      [
        `logged_in_session: ${hasSavedSession()}`,
        `connection: ${client.status}`,
        `account: ${client.meJid ?? "unknown"}`,
      ].join("\n")
    );
  }
);

async function main(): Promise<void> {
  // Connect the MCP transport first so Claude Desktop sees the server
  // immediately; WhatsApp connects in the background.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (hasSavedSession()) {
    client.start().catch((e) => log("[wa-mcp] WhatsApp start failed:", e));
  } else {
    log("[wa-mcp] no saved session - run `npm run login` first");
  }
}

main().catch((e) => {
  log("[wa-mcp] fatal:", e);
  process.exit(1);
});
