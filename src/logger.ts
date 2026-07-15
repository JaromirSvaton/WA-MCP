import pino from "pino";

/**
 * CRITICAL: stdout is reserved for MCP JSON-RPC traffic.
 * Every log line must go to stderr (fd 2), otherwise Claude Desktop
 * fails to parse the protocol stream.
 */
export const baileysLogger = pino(
  { level: process.env.WA_MCP_BAILEYS_LOG || "silent" },
  pino.destination(2)
);

/** Human-readable diagnostics on stderr. */
export function log(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(" ") + "\n");
}
