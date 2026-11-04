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

const thinkingLevelSchema = z.enum(THINKING_LEVELS);

/**
 * Adapter configuration.
 *
 * `thinkingLevel` is an EXPLICIT field: it is always present in a loaded
 * config, defaulting to "medium" (where tiers exist). The ACP-side runtime
 * override (session/set_mode / session/set_config_option) is DEFERRED to a
 * later ticket; in A1 the level can only be changed via this config field
 * or the pi-RPC-side thinking controls (ThinkingController).
 */
export interface AcpConfig {
  thinkingLevel: ThinkingLevel;
  /** Path of the config file this config was loaded from, if any. */
  source?: string;
}

const configFileSchema = z.object({
  thinkingLevel: thinkingLevelSchema.optional(),
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
    return { thinkingLevel: DEFAULT_THINKING_LEVEL };
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
    source: path,
  };
}
