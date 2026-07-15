import Database from "better-sqlite3";
import { jidNormalizedUser, isJidGroup, type proto, type Chat, type Contact } from "@whiskeysockets/baileys";
import { extractContent } from "./extract.js";
import { DB_PATH } from "./config.js";

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  last_message_time: number | null;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  from_me: number;
  timestamp: number;
  text: string;
  type: string;
}

export interface ContactRow {
  jid: string;
  name: string | null;
}

function toUnixSeconds(t: number | { toNumber(): number } | null | undefined): number {
  if (t == null) return 0;
  return typeof t === "number" ? t : t.toNumber();
}

export class Store {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        last_message_time INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        PRIMARY KEY (id, chat_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_jid, timestamp DESC);
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT
      );
    `);
  }

  upsertChat(jid: string, name: string | null | undefined, lastMessageTime?: number): void {
    if (!jid || jid === "status@broadcast") return;
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, is_group, last_message_time)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           last_message_time = MAX(COALESCE(chats.last_message_time, 0), COALESCE(excluded.last_message_time, 0))`
      )
      .run(jid, name ?? null, isJidGroup(jid) ? 1 : 0, lastMessageTime ?? null);
  }

  upsertContact(jid: string, name: string | null | undefined): void {
    if (!jid || !name) return;
    this.db
      .prepare(
        `INSERT INTO contacts (jid, name) VALUES (?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)`
      )
      .run(jid, name);
  }

  storeBaileysChats(chats: Chat[]): void {
    for (const chat of chats) {
      this.upsertChat(chat.id, chat.name ?? null, toUnixSeconds(chat.conversationTimestamp as never));
    }
  }

  storeBaileysContacts(contacts: Partial<Contact>[]): void {
    for (const c of contacts) {
      if (!c.id) continue;
      this.upsertContact(c.id, c.name ?? c.notify ?? c.verifiedName ?? null);
    }
  }

  storeMessage(msg: proto.IWebMessageInfo): void {
    const chatJid = msg.key?.remoteJid;
    const id = msg.key?.id;
    if (!chatJid || !id || chatJid === "status@broadcast") return;

    const content = extractContent(msg.message);
    if (!content) return;

    const fromMe = msg.key?.fromMe ? 1 : 0;
    const senderJid = fromMe
      ? "me"
      : jidNormalizedUser(msg.key?.participant || chatJid);
    const timestamp = toUnixSeconds(msg.messageTimestamp as never);

    this.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender_jid, sender_name, from_me, timestamp, text, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, chat_jid) DO UPDATE SET text = excluded.text`
      )
      .run(id, chatJid, senderJid, msg.pushName ?? null, fromMe, timestamp, content.text, content.type);

    this.upsertChat(chatJid, null, timestamp);
    if (!fromMe && msg.pushName && senderJid.endsWith("@s.whatsapp.net")) {
      // remember push names as fallback contact names
      const existing = this.db.prepare(`SELECT name FROM contacts WHERE jid = ?`).get(senderJid) as
        | { name: string | null }
        | undefined;
      if (!existing?.name) this.upsertContact(senderJid, msg.pushName);
    }
  }

  listChats(limit: number, query?: string): (ChatRow & { contact_name: string | null; last_text: string | null })[] {
    const where = query ? `WHERE (chats.name LIKE @q OR contacts.name LIKE @q OR chats.jid LIKE @q)` : "";
    return this.db
      .prepare(
        `SELECT chats.*, contacts.name AS contact_name,
                (SELECT text FROM messages WHERE messages.chat_jid = chats.jid ORDER BY timestamp DESC LIMIT 1) AS last_text
         FROM chats
         LEFT JOIN contacts ON contacts.jid = chats.jid
         ${where}
         ORDER BY chats.last_message_time DESC
         LIMIT @limit`
      )
      .all({ limit, q: `%${query ?? ""}%` }) as never;
  }

  getMessages(chatJid: string, limit: number, beforeTimestamp?: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_jid = ? ${beforeTimestamp ? "AND timestamp < ?" : ""}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...(beforeTimestamp ? [chatJid, beforeTimestamp, limit] : [chatJid, limit])) as MessageRow[];
    return rows.reverse(); // chronological order
  }

  searchMessages(query: string, limit: number, chatJid?: string): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE text LIKE ? ${chatJid ? "AND chat_jid = ?" : ""}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...(chatJid ? [`%${query}%`, chatJid, limit] : [`%${query}%`, limit])) as MessageRow[];
  }

  searchContacts(query: string, limit: number): (ContactRow & { chat_name: string | null })[] {
    return this.db
      .prepare(
        `SELECT contacts.jid, contacts.name, chats.name AS chat_name
         FROM contacts
         LEFT JOIN chats ON chats.jid = contacts.jid
         WHERE contacts.name LIKE @q OR contacts.jid LIKE @q
         ORDER BY contacts.name
         LIMIT @limit`
      )
      .all({ q: `%${query}%`, limit }) as never;
  }

  getContactName(jid: string): string | null {
    const row = this.db.prepare(`SELECT name FROM contacts WHERE jid = ?`).get(jid) as
      | { name: string | null }
      | undefined;
    return row?.name ?? null;
  }

  getChatName(jid: string): string | null {
    const row = this.db.prepare(`SELECT name FROM chats WHERE jid = ?`).get(jid) as
      | { name: string | null }
      | undefined;
    return row?.name ?? this.getContactName(jid);
  }

  close(): void {
    this.db.close();
  }
}
