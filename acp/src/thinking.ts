import { PiRpc, type PiRecord } from "./pi-rpc.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./config.js";

/**
 * Thinking-level control (ticket ACP-A1, item 5).
 *
 * Each method maps 1:1 onto the matching pi RPC command:
 *
 *   set(level)              -> `set_thinking_level`
 *   getAvailableLevels()    -> `get_available_thinking_levels`
 *   cycle()                 -> `cycle_thinking_level`
 *   getState()              -> `get_state`
 */
export class ThinkingController {
  constructor(private readonly rpc: PiRpc) {}

  /** Set the thinking level for the current pi session. */
  async set(level: ThinkingLevel): Promise<void> {
    if (!THINKING_LEVELS.includes(level)) {
      throw new Error(`unknown thinking level: ${level}`);
    }
    await this.rpc.request("set_thinking_level", { level });
  }

  /**
   * The set of thinking levels the current model supports.
   *
   * Tolerates the shape `data.levels: string[]` (or `data` itself being an
   * array) so we are not coupled to a single envelope.
   */
  async getAvailableLevels(): Promise<ThinkingLevel[]> {
    const data = (await this.rpc.request("get_available_thinking_levels")) as
      | { levels?: unknown }
      | unknown[]
      | undefined;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { levels: unknown[] }).levels)
        ? (data as { levels: unknown[] }).levels
        : [];
    return list.filter(
      (l): l is ThinkingLevel =>
        typeof l === "string" && (THINKING_LEVELS as readonly string[]).includes(l),
    );
  }

  /**
   * Cycle to the next thinking level; returns the new level.
   *
   * The response is expected to carry the new level (`data.thinkingLevel`,
   * with a couple of tolerant fallbacks). If the response carries none, we
   * read it back via get_state.
   */
  async cycle(): Promise<ThinkingLevel> {
    const data = (await this.rpc.request("cycle_thinking_level")) as
      | Record<string, unknown>
      | undefined;
    const level = pickThinkingLevel(data);
    if (level) return level;
    const state = await this.getState();
    const fromState = pickThinkingLevel(state);
    if (!fromState) throw new Error("pi cycle_thinking_level returned no level");
    return fromState;
  }

  /**
   * Current pi session state, including the current thinking level.
   * Returns the raw state object with a normalized `thinkingLevel` field
   * added when pi reports it under a variant key.
   */
  async getState(): Promise<Record<string, unknown>> {
    const data = (await this.rpc.request("get_state")) as
      | Record<string, unknown>
      | undefined;
    const state: Record<string, unknown> =
      data && typeof data === "object" ? { ...data } : {};
    if (state.thinkingLevel === undefined) {
      const alt = pickThinkingLevel(state);
      if (alt) state.thinkingLevel = alt;
    }
    return state;
  }
}

/**
 * Extract a thinking level from a pi data payload, tolerating the common
 * key spellings. Returns null when absent.
 */
function pickThinkingLevel(data: Record<string, unknown> | undefined): ThinkingLevel | null {
  if (!data || typeof data !== "object") return null;
  for (const key of ["thinkingLevel", "thinking_level", "thinking", "level"]) {
    const v = data[key];
    if (typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v)) {
      return v as ThinkingLevel;
    }
  }
  return null;
}

/** Helper re-export so callers can build event maps without importing pi-rpc. */
export type { PiRecord };
