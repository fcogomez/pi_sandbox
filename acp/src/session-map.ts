import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * On-disk session map (ticket ACP-A3, locked decision #1).
 *
 * Maps an ACP session id to the pi session state needed to reload it after a
 * restart:
 *
 *   { "<acpSessionId>": { piSessionId, sessionFile, cwd, thinkingLevel,
 *     createdAt, lastUsedAt } }
 *
 * Path resolution order:
 *   1. explicit path (AcpConfig.sessionMapPath)
 *   2. env ACP_SESSION_MAP_PATH
 *   3. ~/.acp-pi/sessions.json
 *
 * All I/O is async (node:fs/promises). Writes are atomic: write to
 * `<path>.tmp`, then `rename()`. The parent directory is created if missing.
 */
export interface SessionMapEntry {
  /** pi's own session id (from `get_state` `data.sessionId`). */
  piSessionId: string;
  /** Absolute path of pi's session file (`/abs/path.jsonl`). */
  sessionFile: string;
  /** Working directory the ACP session was created in. */
  cwd: string;
  /** Thinking level in effect when the entry was persisted. */
  thinkingLevel: string;
  /** ISO timestamp of the first persistence of this entry. */
  createdAt: string;
  /** ISO timestamp of the most recent create/load/resume. */
  lastUsedAt: string;
}

export type SessionMapData = Record<string, SessionMapEntry>;

/** Fields supplied by the caller on put (timestamps are managed here). */
export type SessionMapInput = Pick<
  SessionMapEntry,
  "piSessionId" | "sessionFile" | "cwd" | "thinkingLevel"
>;

/** Resolve the session map path (see resolution order above). */
export function resolveSessionMapPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  const env = process.env.ACP_SESSION_MAP_PATH;
  if (env) return env;
  return join(homedir(), ".acp-pi", "sessions.json");
}

export class SessionMap {
  private readonly path: string;
  private data: SessionMapData = {};

  constructor(explicitPath?: string) {
    this.path = resolveSessionMapPath(explicitPath);
  }

  /** Resolved path of the map file on disk. */
  get mapPath(): string {
    return this.path;
  }

  /**
   * Load the map from disk. A missing file is an empty map (fresh install);
   * a present-but-corrupt file throws (fail loudly, never silently drop
   * persistence state).
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = {};
        return;
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`session map ${this.path}: expected a JSON object`);
    }
    this.data = parsed as SessionMapData;
  }

  get(acpSessionId: string): SessionMapEntry | undefined {
    return this.data[acpSessionId];
  }

  /**
   * Insert or update an entry (preserving `createdAt`, refreshing
   * `lastUsedAt`) and persist atomically.
   */
  async put(acpSessionId: string, entry: SessionMapInput): Promise<void> {
    const now = new Date().toISOString();
    const prev = this.data[acpSessionId];
    this.data[acpSessionId] = {
      ...entry,
      createdAt: prev?.createdAt ?? now,
      lastUsedAt: now,
    };
    await this.save();
  }

  /** Refresh `lastUsedAt` for an existing entry (no-op when absent). */
  async touch(acpSessionId: string): Promise<void> {
    const entry = this.data[acpSessionId];
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    await this.save();
  }

  /** Remove an entry and persist (used for stale entries in session/load). */
  async remove(acpSessionId: string): Promise<void> {
    delete this.data[acpSessionId];
    await this.save();
  }

  /**
   * Atomic save: write `<path>.tmp`, then `rename()` over the target.
   * The parent directory is created when missing.
   */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
