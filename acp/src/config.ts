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
 */
export const DEFAULT_GATED_TOOLS: readonly string[] = ["bash", "write", "edit"];

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
 *   - `gatedTools`   (default ["bash","write","edit"]): tools whose pi
 *     `tool_call` the bundled extension gates on an ACP permission request.
 *     Exported to the pi subprocess as `ACP_GATED_TOOLS` (comma-joined).
 *   - `fsDelegation` (default true): delegate the read tool to the ACP
 *     client's `fs/read_text_file`. Exported as `ACP_FS_DELEGATION` = "1"/"0".
 */
export interface AcpConfig {
  thinkingLevel: ThinkingLevel;
  /** Tools requiring ACP permission before execution (default bash, write, edit). */
  gatedTools?: string[];
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
    fsDelegation: parsed.data.fsDelegation ?? DEFAULT_FS_DELEGATION,
    sessionMapPath: parsed.data.sessionMapPath,
    source: path,
  };
}
