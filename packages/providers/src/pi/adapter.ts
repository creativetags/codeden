import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import {
  type ForkConversationOptions,
  type ProviderAdapter,
  type ProviderSession,
  ProviderSessionError,
  type RefreshModelsOptions,
} from "../adapter";
import { executableFingerprint, ModelFreshness } from "../freshness";
import { ModelCatalog } from "../models";
import { type ResolvedCommand, spawnResolved } from "../util/exec";
import { findExecutable, type LocateOptions } from "../util/locate";
import type { UtilityModel } from "../utility";
import { detectPi, isSupportedPiVersion, PI_PROVIDER_ID, piTooOldMessage } from "./detect";
import { piEnv } from "./env";
import { writeGateExtension } from "./extension";
import { forkPiConversation } from "./fork";
import { fallbackPiModels, piModelList } from "./models";
import { PiUtilityModel } from "./one-shot";
import type { PiModel, PiState } from "./protocol";
import { PiRpc } from "./rpc";
import { PiSession } from "./session";

/**
 * Honest flags (Principle 5). Pi has no permission system, so every tool call goes through
 * CodeDen's gate extension (`./extension`) and the session's policy (§11.2): approvals, the
 * read-only level and live autonomy therefore behave as on the ACP agents, refusing edits and
 * writing commands in read-only sessions. Steering, interrupt, compaction on demand, reasoning
 * effort and forking are Pi's own (`fork`/`clone`, `./fork`). A dialog from one of the user's own
 * Pi extensions reaches the user as a `user_question`, and its notifications become notices, so
 * questions are wired up. Plan mode is CodeDen's own (§7.2, `./plan`): the gate refuses changes
 * and the agent's first attempt to make one is the plan approval. Not wired up: subagents,
 * rollback and skills management (Pi loads the user's own skills; CodeDen doesn't switch them),
 * so those stay false.
 *
 * Images follow the selected model: Pi's prompt takes them, and a text-only model gets their paths
 * instead (`promptFor`). Session files live in CodeDen's home, so Pi's own `--resume` list never
 * shows them (`vendorHistory` is unset).
 */
const BASE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: true,
  images: true,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: false,
  liveAutonomy: true,
  readOnly: true,
  compact: true,
};

export interface PiAdapterOptions {
  executable?: ResolvedCommand;
  /** Where to look for the CLI (tests); default PATH, then Homebrew's folders on macOS. */
  locate?: LocateOptions;
  /** Max time for a model query or detection. */
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

/** Pi through its RPC mode (`pi --mode rpc`), one process per session (§7.2). */
export class PiAdapter implements ProviderAdapter {
  readonly id = PI_PROVIDER_ID;
  readonly displayName = "Pi";
  private readonly catalog = new ModelCatalog(fallbackPiModels());
  private readonly freshness = new ModelFreshness();
  private found: { command: ResolvedCommand; version: string | null } | undefined;
  private probing: Promise<void> | undefined;
  private readonly utility = new PiUtilityModel(async () => {
    const found = await this.executable().catch(() => undefined);
    return found?.command;
  });

  constructor(private readonly options: PiAdapterOptions = {}) {}
  /** The CLI to run: a given copy, the one detection found, else one looked up now. */
  private async executable(): Promise<{ command: ResolvedCommand; version: string | null }> {
    if (this.options.executable) return { command: this.options.executable, version: null };
    if (this.found) return this.found;
    const lookup = await findExecutable("pi", {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      ...this.options.locate,
    });
    if (!lookup.command) throw new Error("Pi is not installed (no `pi` on PATH)");
    this.found = { command: lookup.command, version: lookup.version };
    return this.found;
  }

  async detect(): Promise<ProviderStatus> {
    // A reinstall or an uninstall since the last detection: look again.
    this.found = undefined;
    return detectPi({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.locate ? { locate: this.options.locate } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
    });
  }

  capabilities(): ProviderCapabilities {
    return { ...BASE_CAPABILITIES };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  /** Side jobs (§7.4): one print-mode call, no session and no tools (`./one-shot`). */
  utilityModel(): UtilityModel {
    return this.utility;
  }

  /** Ask Pi for its account's models with a short-lived process: no session, no model call. */
  async refreshModels(opts: RefreshModelsOptions = {}): Promise<void> {
    let exe: ResolvedCommand;
    try {
      exe = (await this.executable()).command;
    } catch {
      return;
    }
    if (
      opts.maxAgeMs !== undefined &&
      !this.probing &&
      this.freshness.isFresh(executableFingerprint(exe), opts.maxAgeMs)
    ) {
      return;
    }
    this.probing ??= this.queryModels(exe).finally(() => {
      this.probing = undefined;
    });
    await this.probing;
  }

  /** `get_available_models` on a process that never runs a turn, then closed. */
  private async queryModels(exe: ResolvedCommand): Promise<void> {
    const timeoutMs = this.options.probeTimeoutMs ?? 30_000;
    const child = spawnResolved(exe, ["--mode", "rpc", "--no-session", "--no-approve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: piEnv(),
    });
    const rpc = new PiRpc(child, { onRecord: () => undefined, onExit: () => undefined }, "Pi");
    let timer: NodeJS.Timeout | undefined;
    try {
      const query = (async () => {
        const state = await rpc.request<PiState>({ type: "get_state" });
        const data = await rpc.request<{ models?: PiModel[] }>({ type: "get_available_models" });
        const models = (data?.models ?? []).filter((m) => m?.id && m?.provider);
        if (models.length) {
          this.catalog.set(piModelList(models, state?.model));
          this.freshness.confirm(executableFingerprint(exe));
        }
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Pi did not answer in time")), timeoutMs);
        timer.unref?.();
      });
      await Promise.race([query, timeout]);
    } catch {
      // Keep the last good list (or the fallback): a refresh never throws.
    } finally {
      clearTimeout(timer);
      await rpc.close();
    }
  }

  /** Pi's own `fork`/`clone` in a short-lived process (`./fork`); the original stays untouched. */
  async forkConversation(resumeToken: string, opts: ForkConversationOptions): Promise<string> {
    const { command } = await this.executable();
    return forkPiConversation(command, resumeToken, {
      cwd: opts.cwd,
      ...(opts.upTo ? { upTo: opts.upTo } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
    });
  }
  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const { command, version } = await this.executable();
    if (version && !isSupportedPiVersion(version)) {
      throw new ProviderSessionError(
        "version_unsupported",
        `${piTooOldMessage(version)}. Update it with \`pi update\`.`,
        "setup",
      );
    }
    // CodeDen's home holds this session's files and the gate, so the user's Pi list stays theirs.
    const home = opts.codedenHome ?? path.join(tmpdir(), "codeden-pi");
    const sessionDir = path.join(home, "pi", "sessions");
    const session = new PiSession(opts, {
      executable: command,
      extensionPath: writeGateExtension(
        path.join(home, "pi", "extensions"),
        opts.sessionId,
        opts.mcpServers,
      ),
      sessionDir,
      contextWindow: (model) => {
        const list = this.catalog.list();
        const id = model ?? list.find((m) => m.isDefault)?.id;
        return list.find((m) => m.id === id)?.contextWindow;
      },
      ...(this.options.startTimeoutMs ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
      ...(this.options.interruptTimeoutMs
        ? { interruptTimeoutMs: this.options.interruptTimeoutMs }
        : {}),
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    // A session reports the account's models and its own, which keeps the picker current.
    const models = session.models();
    if (models.length) {
      this.catalog.set(piModelList(models, session.currentModel()));
      this.freshness.confirm(executableFingerprint(command));
    }
    return session;
  }
}
