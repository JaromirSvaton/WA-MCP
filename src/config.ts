import * as os from "os";
import * as path from "path";
import * as fs from "fs";

/**
 * All persistent data lives in ~/.wa-mcp (absolute path).
 * Claude Desktop spawns MCP servers with an arbitrary working directory,
 * so relative paths must never be used.
 */
export const DATA_DIR = process.env.WA_MCP_DATA_DIR || path.join(os.homedir(), ".wa-mcp");
export const AUTH_DIR = path.join(DATA_DIR, "auth");
export const DB_PATH = path.join(DATA_DIR, "messages.db");

export function ensureDataDirs(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}
