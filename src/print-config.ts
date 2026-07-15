/**
 * Prints the exact Claude Desktop config snippet for this machine,
 * using absolute paths so it works regardless of PATH or cwd.
 */
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
const nodePath = process.execPath;

const snippet = {
  mcpServers: {
    whatsapp: {
      command: nodePath,
      args: [serverPath],
    },
  },
};

console.log("\n1. Run `npm run login` and scan the QR code (one time only).");
console.log("\n2. Add this to your Claude Desktop config file:");
console.log(`   ${path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")}\n`);
console.log(JSON.stringify(snippet, null, 2));
console.log("\n(If the file already has an \"mcpServers\" object, merge the \"whatsapp\" entry into it.)");
console.log("\n3. Fully restart Claude Desktop (quit from the system tray, then reopen).\n");
