import type {
  AgentSideConnection,
  PermissionOption,
} from "@agentclientprotocol/sdk";
import { piToolKind } from "./tool-mapping.js";

/**
 * ACP `session/request_permission` round-trip for pi tool calls (ticket ACP-A2).
 *
 * Flow (per the locked A2 design): the bundled pi extension gates a tool call
 * on pi's `tool_call` event and calls `ctx.ui.select(...)`; in RPC mode pi
 * emits an `extension_ui_request` (method "select") whose title uses the
 * prefix convention below. The adapter intercepts it, runs this round-trip
 * against the ACP client, and writes the selected option back to pi as an
 * `extension_ui_response`.
 */

/** Title prefix the pi extension uses for permission selects. */
export const PERM_TITLE_PREFIX = "[acp:perm] ";

/**
 * Extension title convention:
 *   `[acp:perm] <toolName> [id:<toolCallId>] <args summary>`
 */
export function buildPermTitle(toolName: string, toolCallId: string, argsSummary: string): string {
  return `${PERM_TITLE_PREFIX}${toolName} [id:${toolCallId}] ${argsSummary}`;
}

export interface PermTitleParts {
  toolName: string;
  toolCallId: string;
  argsSummary: string;
}

/** Parse an extension permission select title (see `buildPermTitle`). */
export function parsePermTitle(title: string): PermTitleParts | null {
  if (!title.startsWith(PERM_TITLE_PREFIX)) return null;
  const rest = title.slice(PERM_TITLE_PREFIX.length);
  const spaceIdx = rest.indexOf(" ");
  const toolName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const idMatch = rest.match(/\[id:([^\]]*)\]/);
  const tail = idMatch ? rest.slice(idMatch.index! + idMatch[0].length) : "";
  return {
    toolName,
    toolCallId: idMatch ? idMatch[1] : "",
    argsSummary: tail.trim(),
  };
}

/** The exactly-2 locked permission options (no "always" variants in A2). */
export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

export type PermissionOutcome = "allow" | "reject";

export interface RequestToolPermissionParams {
  connection: AgentSideConnection;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Human-readable args summary used for the tool call title. */
  argsSummary: string;
}

/**
 * Run the ACP permission round-trip:
 *   1. emit a `tool_call` session update with status "pending"
 *   2. `connection.requestPermission(...)` with the 2 locked options
 *   3. return "allow" | "reject"
 *
 * Option ids starting with "allow" → allow; starting with "reject" → block.
 * A cancelled outcome is treated as reject (safe default).
 */
export async function requestToolPermission(
  params: RequestToolPermissionParams,
): Promise<PermissionOutcome> {
  const { connection, sessionId, toolCallId, toolName, argsSummary } = params;
  const title = `${toolName}: ${argsSummary}`;
  const kind = piToolKind(toolName);

  // 1) pending tool_call so the client can render the in-flight call.
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind,
      status: "pending",
    },
  });

  // 2) ask the client.
  const res = await connection.requestPermission({
    sessionId,
    toolCall: { toolCallId, title, kind, status: "pending" },
    options: PERMISSION_OPTIONS,
  });

  // 3) interpret the outcome.
  if (res.outcome.outcome !== "selected") return "reject";
  const optionId = res.outcome.optionId;
  if (optionId.startsWith("allow")) return "allow";
  if (optionId.startsWith("reject")) return "reject";
  // Unknown option id: never grant.
  return "reject";
}
