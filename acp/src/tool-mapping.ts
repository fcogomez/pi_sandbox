import type { ContentBlock, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { PiRecord } from "./pi-rpc.js";

/**
 * Tool event → ACP session/update mapping (ticket ACP-A2).
 *
 * Pure functions, no I/O. pi 0.85.x emits these session events for tool
 * execution (all carry `toolCallId`, `toolName`):
 *
 *   tool_execution_start   { toolCallId, toolName, args }
 *   tool_execution_update  { toolCallId, toolName, partialResult }
 *   tool_execution_end     { toolCallId, toolName, result, isError }
 *
 * pi's `toolCallId` is used directly as the ACP `toolCallId` (no translation).
 */

/** Locked A2 ToolKind mapping. */
export function piToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    case "grep":
    case "find":
    case "ls":
      return "search";
    default:
      return "other";
  }
}

/**
 * Tool name -> ACP ToolKind (the locked A2 mapping). A3 reuses this for
 * history replay (`toolCall` blocks in `get_messages`) so live tool events
 * and replayed history always map to the same kind.
 */
export function toolNameToKind(toolName: string): ToolKind {
  return piToolKind(toolName);
}

/**
 * Human-readable "args summary" for a tool call title:
 *   bash          -> args.command
 *   read/write/edit -> args.path
 *   grep/find     -> args.pattern (+ " " + args.path when present)
 *   anything else -> JSON.stringify(args) truncated to 80 chars
 */
export function argsSummary(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash" && typeof args.command === "string") {
    return args.command;
  }
  if (
    (toolName === "read" || toolName === "write" || toolName === "edit") &&
    typeof args.path === "string"
  ) {
    return args.path;
  }
  if (toolName === "grep" || toolName === "find") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const path = typeof args.path === "string" ? args.path : "";
    return pattern && path ? `${pattern} ${path}` : pattern || path;
  }
  const s = JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 80) : s;
}

/** Wrap pi content blocks ({type:"text",text}) as ACP ToolCallContent. */
function toToolCallContent(blocks: unknown): Array<{ type: "content"; content: ContentBlock }> | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  return blocks.map((b) => ({ type: "content" as const, content: b as ContentBlock }));
}

/**
 * Map a pi tool execution event to the corresponding ACP `session/update`,
 * or `null` when the event has no ACP-side mapping.
 */
export function piToolEventToAcpUpdate(
  ev: PiRecord,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): SessionUpdate | null {
  switch (ev.type) {
    case "tool_execution_start":
      return {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `${toolName}: ${argsSummary(toolName, args)}`,
        kind: toolNameToKind(toolName),
        status: "in_progress",
        rawInput: args,
        locations: typeof args.path === "string" && args.path !== "" ? [{ path: args.path }] : undefined,
      };

    case "tool_execution_update": {
      const partialResult = ev.partialResult as { content?: unknown } | undefined;
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        content: toToolCallContent(partialResult?.content),
      };
    }

    case "tool_execution_end":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: ev.isError ? "failed" : "completed",
        content: toToolCallContent((ev.result as { content?: unknown } | undefined)?.content),
        rawOutput: ev.result,
      };

    default:
      return null;
  }
}
