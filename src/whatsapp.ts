import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type GroupMetadata,
  type proto,
} from "@whiskeysockets/baileys";
import * as fs from "fs";
import * as path from "path";
import { AUTH_DIR, ensureDataDirs } from "./config.js";
import { baileysLogger, log } from "./logger.js";
import type { Store } from "./store.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "logged_out";

export interface WhatsAppClientOptions {
  store: Store;
  /** Called when a QR code needs to be scanned (login flow). */
  onQr?: (qr: string) => void;
  /** Called once the connection is fully open. */
  onOpen?: () => void;
  /** Called after each history-sync batch is ingested. */
  onHistorySync?: () => void;
}

export function hasSavedSession(): boolean {
  try {
    const credsPath = path.join(AUTH_DIR, "creds.json");
    if (!fs.existsSync(credsPath)) return false;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return Boolean(creds?.registered || creds?.me?.id);
  } catch {
    return false;
  }
}

export function clearSession(): void {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

export class WhatsAppClient {
  sock: WASocket | null = null;
  status: ConnectionStatus = "disconnected";
  meJid: string | null = null;

  private opts: WhatsAppClientOptions;
  private stopped = false;
  private reconnectDelay = 2000;
  private groupCache = new Map<string, { meta: GroupMetadata; fetchedAt: number }>();

  constructor(opts: WhatsAppClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    ensureDataDirs();
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
    this.status = "disconnected";
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.status = "connecting";

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as never }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger as never,
      printQRInTerminal: false,
      markOnlineOnConnect: false, // keep phone notifications working
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && this.opts.onQr) this.opts.onQr(qr);

      if (connection === "open") {
        this.status = "connected";
        this.reconnectDelay = 2000;
        this.meJid = sock.user?.id ?? null;
        log(`[wa-mcp] connected as ${sock.user?.id ?? "?"}`);
        this.opts.onOpen?.();
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          this.status = "logged_out";
          log("[wa-mcp] session logged out. Run `npm run login` to re-link.");
          clearSession();
          return;
        }
        this.status = "disconnected";
        if (this.stopped) return;
        const delay = statusCode === DisconnectReason.restartRequired ? 500 : this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
        log(`[wa-mcp] connection closed (code ${statusCode ?? "?"}), reconnecting in ${delay}ms`);
        setTimeout(() => void this.connect().catch((e) => log("[wa-mcp] reconnect error:", e)), delay);
      }
    });

    // --- ingestion into SQLite ---
    const store = this.opts.store;

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      store.storeBaileysChats(chats);
      store.storeBaileysContacts(contacts);
      for (const msg of messages) store.storeMessage(msg);
      log(`[wa-mcp] history sync: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages`);
      this.opts.onHistorySync?.();
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) store.storeMessage(msg);
    });

    sock.ev.on("chats.upsert", (chats) => store.storeBaileysChats(chats));
    sock.ev.on("chats.update", (updates) => {
      for (const u of updates) if (u.id) store.upsertChat(u.id, u.name ?? null);
    });
    sock.ev.on("contacts.upsert", (contacts) => store.storeBaileysContacts(contacts));
    sock.ev.on("contacts.update", (updates) => store.storeBaileysContacts(updates as never));

    sock.ev.on("groups.upsert", (groups) => {
      for (const g of groups) store.upsertChat(g.id, g.subject);
    });
  }

  async waitForConnection(timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.status === "connected") return true;
      if (this.status === "logged_out") return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async sendText(jid: string, text: string): Promise<proto.WebMessageInfo | undefined> {
    if (!this.sock || this.status !== "connected") {
      throw new Error("WhatsApp is not connected");
    }
    const result = await this.sock.sendMessage(jid, { text });
    if (result) this.opts.store.storeMessage(result);
    return result ?? undefined;
  }

  async getGroupMetadata(jid: string): Promise<GroupMetadata> {
    if (!this.sock || this.status !== "connected") {
      throw new Error("WhatsApp is not connected");
    }
    const cached = this.groupCache.get(jid);
    if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) return cached.meta;
    const meta = await this.sock.groupMetadata(jid);
    this.groupCache.set(jid, { meta, fetchedAt: Date.now() });
    this.opts.store.upsertChat(jid, meta.subject);
    return meta;
  }
}

/** Accepts a phone number ("+420 777 123 456") or a full JID and returns a JID. */
export function normalizeRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  if (trimmed.endsWith("@g.us") || trimmed.endsWith("@s.whatsapp.net") || trimmed.endsWith("@lid")) {
    return trimmed;
  }
  if (trimmed.endsWith("@c.us")) {
    return trimmed.replace("@c.us", "@s.whatsapp.net");
  }
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) throw new Error(`Cannot interpret recipient: "${recipient}". Use a phone number or a JID.`);
  return `${digits}@s.whatsapp.net`;
}
