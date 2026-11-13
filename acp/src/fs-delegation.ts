import type {
  AgentSideConnection,
  ClientCapabilities,
} from "@agentclientprotocol/sdk";

/**
 * ACP `fs/read_text_file` delegation for the bundled read-tool override
 * (ticket ACP-A2) and `fs/write_text_file` delegation for the bundled
 * write-tool override (ticket ACP-C3).
 *
 * The pi extension's `read` override calls `ctx.ui.input("[acp:read] <abs
 * path>")`; in RPC mode pi emits an `extension_ui_request` (method "input")
 * and blocks. The adapter intercepts it, calls `readTextFile` on the ACP
 * client, and writes the content back as an `extension_ui_response`.
 *
 * The write override calls `ctx.ui.input("[acp:write] <toolCallId> <abs
 * path>")`; the adapter intercepts it, looks up the write args it stored
 * from the tool_execution_start event (content NEVER travels through the
 * dialog), calls `writeTextFile` on the ACP client, and writes `"ok"` back
 * on success or `cancelled: true` (local fallback) otherwise.
 */

/** Title prefix the pi extension uses for read delegation inputs. */
export const READ_TITLE_PREFIX = "[acp:read] ";

/** Title prefix the pi extension uses for write delegation inputs. */
export const WRITE_TITLE_PREFIX = "[acp:write] ";

/**
 * Ask the ACP client to read a text file.
 *
 * Returns the file content, or `null` when the client does not support it
 * (capability not advertised, no method available, or the request fails) —
 * the caller then writes `cancelled: true` back to pi so the extension can
 * fall back to its own behavior.
 */
export async function handleReadDelegation(
  sessionId: string,
  filePath: string,
  connection: AgentSideConnection,
  clientCapabilities?: ClientCapabilities,
): Promise<string | null> {
  if (!clientCapabilities?.fs?.readTextFile) return null;
  if (typeof connection.readTextFile !== "function") return null;
  try {
    const res = await connection.readTextFile({ sessionId, path: filePath });
    return typeof res.content === "string" ? res.content : null;
  } catch {
    return null;
  }
}

export interface WriteTitleParts {
  toolCallId: string;
  path: string;
}

/**
 * Parse a write-delegation input title:
 *   `[acp:write] <toolCallId> <absolutePath>`
 * (single space separated; the toolCallId never contains spaces, so the
 * path is everything after the first space). Returns null when the title
 * is malformed.
 */
export function parseWriteTitle(title: string): WriteTitleParts | null {
  if (!title.startsWith(WRITE_TITLE_PREFIX)) return null;
  const rest = title.slice(WRITE_TITLE_PREFIX.length);
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx === -1) return null;
  const toolCallId = rest.slice(0, spaceIdx);
  const path = rest.slice(spaceIdx + 1);
  if (toolCallId.length === 0 || path.length === 0) return null;
  return { toolCallId, path };
}

/**
 * Ask the ACP client to write a text file (ticket ACP-C3).
 *
 * `content` is the caller's STORED copy of the write tool's args — it is
 * never parsed from or transported via the dialog title.
 *
 * Returns `"ok"` on success, `null` when the client does not support the
 * write (capability not advertised, no method available) — the caller then
 * writes `cancelled: true` back to pi so the extension falls back to a
 * local write. Transport/write errors are rethrown: the caller logs them
 * (path + error string, never the content) and cancels.
 */
export async function handleWriteDelegation(
  sessionId: string,
  filePath: string,
  content: string,
  connection: AgentSideConnection,
  clientCapabilities?: ClientCapabilities,
): Promise<"ok" | null> {
  if (!clientCapabilities?.fs?.writeTextFile) return null;
  if (typeof connection.writeTextFile !== "function") return null;
  await connection.writeTextFile({ sessionId, path: filePath, content });
  return "ok";
}
