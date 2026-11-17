import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * pi thinking levels (the enum for `--thinking` / set_thinking_level).
 * Verified against pi 0.85.x.
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Default thinking level applied to new sessions when the model supports
 * tiers. `medium` is the documented default for A1.
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * Tools that require an ACP `session/request_permission` round-trip before
 * pi executes them (read-only tools like read/grep/find/ls are not gated).
 * Exported as `ACP_GATED_TOOLS` (comma-joined) to the pi subprocess.
 *
 * M2.1: entries may be exact tool names OR `prefix*` patterns (a trailing
 * `*` is a prefix match). The `mcp__xcode_tools__*` catch-all gates every
 * Xcode MCP tool (present or future); the read-only carve-out lives in
 * `DEFAULT_UNGATED_TOOLS`.
 */
export const DEFAULT_GATED_TOOLS: readonly string[] = [
  "bash",
  "write",
  "edit",
  "mcp__xcode_tools__*",
];

/**
 * M2.1: base names of the read-only Xcode MCP tools (mcp-relay server
 * `xcode-tools`) that are CARVED OUT of the `mcp__xcode_tools__*` gated
 * catch-all — they run without a permission prompt. Exported as
 * `ACP_UNGATED_TOOLS` (comma-joined, full tool names) to the pi subprocess.
 */
const XCODE_READ_ONLY_TOOLS = [
  "DocumentationSearch",
  "XcodeRead",
  "XcodeGrep",
  "XcodeGlob",
  "XcodeLS",
  "XcodeGetCurrentFile",
  "XcodeListNavigatorIssues",
  "XcodeListRunDestinations",
  "XcodeListSchemes",
  "XcodeListTargets",
  "XcodeListTemplates",
  "XcodeListTestPlans",
  "XcodeListWindows",
  "GetBuildLog",
  "GetConsoleOutput",
  "GetCrashIssueLogs",
  "GetFieldPerformanceIssueLogs",
  "GetFileCompilerFlags",
  "GetTargetBuildSettings",
  "GetTestList",
  "GetTopCrashIssues",
  "GetTopFieldPerformanceIssues",
  "StringCatalogContext",
  "StringCatalogRead",
  "RenderPreview",
] as const;

/** Default ungated tools: the read-only `mcp__xcode_tools__*` set. */
export const DEFAULT_UNGATED_TOOLS: readonly string[] =
  XCODE_READ_ONLY_TOOLS.map((n) => `mcp__xcode_tools__${n}`);

/**
 * M2.1: does an exact/pattern match hold? A pattern is either an exact
 * tool name or `prefix*` (trailing `*` = prefix match).
 */
function patternMatches(name: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

/**
 * M2.1: pure gate check used by the bundled pi extension (and the fake pi
 * in tests). A tool name is gated iff it matches at least one `gated`
 * pattern (exact or `prefix*`) AND matches NO `ungated` pattern. Empty
 * pattern lists never match.
 */
export function isGatedTool(
  name: string,
  gated: readonly string[],
  ungated: readonly string[] = [],
): boolean {
  return (
    gated.some((p) => patternMatches(name, p)) &&
    !ungated.some((p) => patternMatches(name, p))
  );
}

/** Default read delegation: ask the ACP client via fs/read_text_file. */
export const DEFAULT_FS_DELEGATION = true;

const thinkingLevelSchema = z.enum(THINKING_LEVELS);

/**
 * Adapter configuration.
 *
 * `thinkingLevel` is an EXPLICIT field: it is always present in a loaded
 * config, defaulting to "medium" (where tiers exist). The ACP-side runtime
 * override (session/set_mode / session/set_config_option) is DEFERRED to a
 * later ticket; in A1 the level can only be changed via this config field
 * or the pi-RPC-side thinking controls (ThinkingController).
 *
 * A2 adds:
 *   - `gatedTools`   (default ["bash","write","edit","mcp__xcode_tools__*"]):
 *     tools whose pi `tool_call` the bundled extension gates on an ACP
 *     permission request. Entries may be exact names or `prefix*` patterns.
 *     Exported to the pi subprocess as `ACP_GATED_TOOLS` (comma-joined).
 *   - `ungatedTools` (M2.1; default: the read-only `mcp__xcode_tools__*`
 *     Xcode tools): exact-name / `prefix*` patterns carved out of any
 *     gated pattern (a tool matching an ungated pattern is never gated).
 *     Exported as `ACP_UNGATED_TOOLS` (comma-joined; "" = none).
 *   - `fsDelegation` (default true): delegate the read tool to the ACP
 *     client's `fs/read_text_file`. Exported as `ACP_FS_DELEGATION` = "1"/"0".
 */
export interface AcpConfig {
  thinkingLevel: ThinkingLevel;
  /**
   * Tools requiring ACP permission before execution (default bash, write,
   * edit + the `mcp__xcode_tools__*` catch-all). Exact names or `prefix*`.
   */
  gatedTools?: string[];
  /**
   * M2.1: exact-name / `prefix*` patterns exempt from gating (default: the
   * read-only `mcp__xcode_tools__*` Xcode tools).
   */
  ungatedTools?: string[];
  /** Delegate read_text_file to the ACP client (default true). */
  fsDelegation?: boolean;
  /**
   * A3: path of the on-disk session map JSON file. Resolution order:
   * this field -> env ACP_SESSION_MAP_PATH -> ~/.acp-pi/sessions.json.
   */
  sessionMapPath?: string;
  /** Path of the config file this config was loaded from, if any. */
  source?: string;
}

const configFileSchema = z.object({
  thinkingLevel: thinkingLevelSchema.optional(),
  gatedTools: z.array(z.string()).optional(),
  ungatedTools: z.array(z.string()).optional(),
  fsDelegation: z.boolean().optional(),
  sessionMapPath: z.string().optional(),
});

/**
 * Load adapter configuration.
 *
 * A1: read a JSON config file if present (path given explicitly, or from the
 * `ACP_PI_CONFIG` env var, or `./acp.config.json` in the working directory).
 * Missing file → defaults. Present but invalid file → throw.
 */
export function loadConfig(options?: { configPath?: string }): AcpConfig {
  const explicit = options?.configPath;
  const candidates = [
    explicit,
    explicit ? undefined : process.env.ACP_PI_CONFIG,
    explicit ? undefined : resolve(process.cwd(), "acp.config.json"),
  ].filter((p): p is string => typeof p === "string");

  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    return {
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      gatedTools: [...DEFAULT_GATED_TOOLS],
      ungatedTools: [...DEFAULT_UNGATED_TOOLS],
      fsDelegation: DEFAULT_FS_DELEGATION,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`acp config: failed to parse ${path}: ${String(err)}`);
  }
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `acp config: invalid config at ${path}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return {
    thinkingLevel: parsed.data.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    gatedTools: parsed.data.gatedTools ?? [...DEFAULT_GATED_TOOLS],
    ungatedTools: parsed.data.ungatedTools ?? [...DEFAULT_UNGATED_TOOLS],
    fsDelegation: parsed.data.fsDelegation ?? DEFAULT_FS_DELEGATION,
    sessionMapPath: parsed.data.sessionMapPath,
    source: path,
  };
}
