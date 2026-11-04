// @ts-nocheck
/**
 * Bundled pi extension for the ACP adapter (ticket ACP-A2).
 *
 * Standalone file at the package root — NOT compiled by tsup (the tsup
 * entry stays src/index.ts). The adapter passes this file's absolute path
 * to pi via `-e`, and pi loads it with its own tsx loader at runtime.
 * That is why `@earendil-works/pi-coding-agent` is imported here but is
 * NOT a dependency of this package (it is resolved by pi's loader), and
 * why this file starts with @ts-nocheck (the package tsc cannot resolve
 * that module).
 *
 * Single default export implementing BOTH A2 features:
 *
 *  1) Permission gate — on pi's `tool_call` event (fires before tool
 *     execution, can block via `{ block: true, reason }`), gated tools
 *     (env ACP_GATED_TOOLS, default "bash,write,edit") ask the user via
 *     `ctx.ui.select`. In RPC mode pi emits an `extension_ui_request`
 *     (method "select") on stdout and blocks; the ACP adapter bridges it
 *     to `session/request_permission` and writes the selected option
 *     ("allow_once" | "reject_once") back. A reject (or cancelled/undefined
 *     choice) blocks the tool.
 *
 *  2) Read-tool override — overrides the built-in `read` tool (official pi
 *     tool-override mechanism; see pi examples/extensions/tool-override.ts).
 *     When env ACP_FS_DELEGATION === "1" the override asks the ACP client
 *     for the file contents via `ctx.ui.input("[acp:read] <absolutePath>")`
 *     (RPC mode: `extension_ui_request` method "input"); the adapter bridges
 *     it to `fs/read_text_file`. When the response is undefined (client
 *     cancelled / doesn't support it), the extension reports a cancelled
 *     read. When ACP_FS_DELEGATION is not "1", it reads locally from the
 *     container filesystem.
 *
 * Env vars are read at load time (set by the adapter at pi spawn):
 *   ACP_GATED_TOOLS    comma-joined tool names, default "bash,write,edit"
 *   ACP_FS_DELEGATION  "1" (delegate read to the ACP client) or "0" (local)
 */
import { constants, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const gated = new Set(
  (process.env.ACP_GATED_TOOLS ?? "bash,write,edit").split(",").filter(Boolean),
);
const delegateRead = process.env.ACP_FS_DELEGATION === "1";

// Title prefixes shared with the adapter (src/permissions.ts,
// src/fs-delegation.ts): the adapter recognizes and parses these.
const PERM_PREFIX = "[acp:perm] ";
const READ_PREFIX = "[acp:read] ";

// Plain JSON schema for the read tool (matches pi's built-in read
// parameters: path, optional offset (1-indexed), optional limit).
const readSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file to read (relative or absolute)",
    },
    offset: {
      type: "number",
      description: "Line number to start reading from (1-indexed)",
    },
    limit: {
      type: "number",
      description: "Maximum number of lines to read",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

export default function (pi: ExtensionAPI) {
  // 1) Permission gate: fires before execution of gated tools; can block.
  pi.on("tool_call", async (event, ctx) => {
    if (!gated.has(event.toolName)) return;
    const summary = JSON.stringify(event.input ?? {}).slice(0, 80);
    const title = `${PERM_PREFIX}${event.toolName} [id:${event.toolCallId}] ${summary}`;
    const choice = await ctx.ui.select(title, ["allow_once", "reject_once"]);
    if (choice === "reject_once" || choice === undefined) {
      return { block: true, reason: `User denied ${event.toolName}` };
    }
    // choice === "allow_once" (or any allow* option): proceed.
  });

  // 2) Override built-in read tool for ACP fs delegation.
  pi.registerTool({
    name: "read", // same name as built-in -> overrides it
    label: "read",
    description: "Read the contents of a file.",
    parameters: readSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolve(ctx.cwd, params.path);
      let content;
      if (delegateRead) {
        // Ask the ACP client (Xcode) to read the file on its side.
        content = await ctx.ui.input(`${READ_PREFIX}${absolutePath}`);
        if (content === undefined) {
          return {
            content: [{ type: "text", text: "File read cancelled by client" }],
            details: { error: true },
          };
        }
      } else {
        // Fallback: local read from the container filesystem.
        try {
          await access(absolutePath, constants.R_OK);
          content = await readFile(absolutePath, "utf-8");
        } catch (e) {
          return {
            content: [{ type: "text", text: `Error reading file: ${e.message}` }],
            details: { error: true },
          };
        }
      }
      // Apply offset/limit to the returned content.
      const lines = content.split("\n");
      const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
      const endLine = params.limit ? startLine + params.limit : lines.length;
      const selected = lines.slice(startLine, endLine).join("\n");
      return {
        content: [{ type: "text", text: selected }],
        details: { lines: lines.length },
      };
    },
    // No renderCall/renderResult — the built-in renderer is used.
  });
}
