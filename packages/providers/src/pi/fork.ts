import path from "node:path";
import { FORK_POINT_MISSING, ProviderSessionError } from "../adapter";
import { type ResolvedCommand, spawnResolved } from "../util/exec";
import { piEnv } from "./env";
import type { PiCommand, PiEntry, PiForkMessage, PiState } from "./protocol";
import { PiRpc } from "./rpc";

export interface PiForkOptions {
  /** An existing folder of the project; the copy is resumed from CodeDen's worktree. */
  cwd: string;
  /** The copy ends with the turn whose end carried this fork point. */
  upTo?: string;
  /** How long Pi gets to answer each step of the fork. */
  timeoutMs?: number;
}

/** What Pi answers a `fork` or `clone` with: cancelled when one of the user's extensions refused. */
interface PiCopyResponse {
  cancelled?: boolean;
}

/**
 * Copy a Pi conversation into a new session and return the new session file (§7.2). A short-lived
 * `pi --mode rpc --session <file>` (no turn runs) answers for the session: Pi's own `fork` copies
 * the branch from a user message into a new session file, and `clone` copies the whole active
 * branch when no user message follows the fork point. The original is never written to.
 *
 * With `upTo` (the entry id a turn ended on), the copy must end at that turn: a conversation that
 * no longer holds the entry throws `FORK_POINT_MISSING` before anything is copied.
 */
export async function forkPiConversation(
  exe: ResolvedCommand,
  resumeToken: string,
  opts: PiForkOptions,
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Pi stores a copy next to the session it copies from: CodeDen's own folder, so the user's own
  // `pi --resume` list stays theirs. A token from elsewhere keeps its own folder.
  const sessionDir = path.dirname(resumeToken);
  const child = spawnResolved(
    exe,
    ["--mode", "rpc", "--session", resumeToken, "--session-dir", sessionDir, "--no-approve"],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: piEnv() },
  );
  const rpc = new PiRpc(child, { onRecord: () => undefined, onExit: () => undefined }, "Pi");
  try {
    const from = opts.upTo ? await forkStartAfter(rpc, opts.upTo, timeoutMs) : undefined;
    // `fork` leaves out the user message it starts from, so the copy ends with the turn before it;
    // with no such message the fork point is the end of the branch, and `clone` copies all of it.
    const copy = await call<PiCopyResponse>(
      rpc,
      from ? { type: "fork", entryId: from } : { type: "clone" },
      timeoutMs,
    );
    if (copy?.cancelled) {
      throw new ProviderSessionError(
        "fork_cancelled",
        "Pi did not copy the conversation (an extension cancelled the fork)",
      );
    }
    const state = await call<PiState>(rpc, { type: "get_state" }, timeoutMs);
    if (!state?.sessionFile) throw new Error("Pi made no session file for the copy");
    return state.sessionFile;
  } finally {
    await rpc.close();
  }
}

/**
 * Where a fork of the conversation up to `upTo` starts: the first user message of the active
 * branch that comes after it, or `undefined` when the fork point ends the branch (the whole
 * branch is the copy). A fork point the session no longer holds throws `FORK_POINT_MISSING`.
 */
async function forkStartAfter(
  rpc: PiRpc,
  upTo: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const entries = await call<{ entries?: PiEntry[] }>(rpc, { type: "get_entries" }, timeoutMs);
  const list = (entries?.entries ?? []).filter((entry) => typeof entry?.id === "string");
  const index = list.findIndex((entry) => entry.id === upTo);
  if (index < 0) {
    throw new ProviderSessionError(
      FORK_POINT_MISSING,
      "The conversation no longer holds the end of that turn (it was replaced or deleted), so it can't be forked there",
    );
  }
  const messages = await call<{ messages?: PiForkMessage[] }>(
    rpc,
    { type: "get_fork_messages" },
    timeoutMs,
  );
  // Pi lists the active branch's user messages in order; the first one after the fork point is
  // where the copy stops.
  const order = new Map(list.map((entry, at) => [entry.id, at]));
  const after = (messages?.messages ?? [])
    .map((message) => ({ id: message.entryId, at: order.get(message.entryId) ?? -1 }))
    .filter((message) => message.at > index)
    .sort((a, b) => a.at - b.at);
  return after[0]?.id;
}

/** Run one command with a deadline: a refusal or a timeout is a plain error. */
async function call<T>(rpc: PiRpc, command: PiCommand, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Pi did not answer in time")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([rpc.request<T>(command), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
