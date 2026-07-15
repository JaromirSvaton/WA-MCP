/**
 * Standalone one-time login: run `npm run login` in a real terminal,
 * scan the QR code with your phone (WhatsApp > Linked Devices),
 * wait for the history sync, done. Claude Desktop never needs to see a QR.
 *
 * `npm run logout` wipes the saved session.
 */
import qrcode from "qrcode-terminal";
import { Store } from "./store.js";
import { WhatsAppClient, hasSavedSession, clearSession } from "./whatsapp.js";
import { ensureDataDirs, DATA_DIR } from "./config.js";

async function main(): Promise<void> {
  if (process.argv.includes("--logout")) {
    clearSession();
    console.log("Session cleared. Also remove the linked device from your phone (WhatsApp > Linked Devices).");
    return;
  }

  ensureDataDirs();
  console.log(`Data directory: ${DATA_DIR}`);
  if (hasSavedSession()) {
    console.log("A saved session already exists - connecting with it (no QR needed).");
    console.log("If you want a fresh login, run `npm run logout` first.\n");
  } else {
    console.log("Waiting for QR code...\n");
  }

  const store = new Store();
  let syncTimer: NodeJS.Timeout | null = null;
  let done = false;

  const finish = (client: WhatsAppClient) => {
    if (done) return;
    done = true;
    console.log("\nLogin complete. Session saved. You can now use the MCP server in Claude Desktop.");
    void client.stop().then(() => process.exit(0));
  };

  // each history batch resets the timer; finish 15s after the last batch
  const arm = (ms: number) => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => finish(client), ms);
  };

  const client: WhatsAppClient = new WhatsAppClient({
    store,
    onQr: (qr) => {
      qrcode.generate(qr, { small: true }, (art) => {
        console.log(art);
        console.log("Scan this with your phone: WhatsApp > Settings > Linked Devices > Link a Device");
      });
    },
    onOpen: () => {
      console.log("\nConnected! Syncing message history (this takes ~15-60 seconds)...");
      arm(20_000);
    },
    onHistorySync: () => arm(15_000),
  });

  await client.start();

  // safety net: never hang forever
  setTimeout(() => {
    if (!done) {
      console.log("\nTimed out waiting for connection. Try again.");
      process.exit(1);
    }
  }, 5 * 60_000);
}

main().catch((e) => {
  console.error("Login failed:", e);
  process.exit(1);
});
