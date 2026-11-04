import type {
  AgentSideConnection,
  ClientCapabilities,
} from "@agentclientprotocol/sdk";

/**
 * ACP `fs/read_text_file` delegation for the bundled read-tool override
 * (ticket ACP-A2).
 *
 * The pi extension's `read` override calls `ctx.ui.input("[acp:read] <abs
 * path>")`; in RPC mode pi emits an `extension_ui_request` (method "input")
 * and blocks. The adapter intercepts it, calls `readTextFile` on the ACP
 * client, and writes the content back as an `extension_ui_response`.
 */

/** Title prefix the pi extension uses for read delegation inputs. */
export const READ_TITLE_PREFIX = "[acp:read] ";

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
