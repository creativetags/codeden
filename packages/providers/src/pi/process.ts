import type { SessionOptions } from "@codeden/contracts";
import { ProviderSessionError } from "../adapter";
import { type ResolvedCommand, spawnResolved } from "../util/exec";
import { piEnv } from "./env";
import { GATE_STATUS_KEY } from "./extension";
import { splitModelId } from "./models";
import type { PiRecord } from "./protocol";
import { PiRpc } from "./rpc";

export interface PiProcessConfig {
  /** The installed `pi` to run. */
  executable: ResolvedCommand;
  /** The session's gate extension (approvals and CodeDen's MCP servers), written per session. */
  extensionPath: string;
  /** Where Pi keeps this session's files: CodeDen's own folder, so the user's Pi list stays clean. */
  sessionDir: string;
  /** Time Pi gets to start and load the gate before the session is refused. */
  startTimeoutMs?: number;
  /** The model the session runs (`<provider>/<model>`); absent leaves Pi's own. */
  model: () => string | undefined;
}

export interface PiProcessCallbacks {
  /** Every record that is not a command response: a session event or an extension's call. */
  onRecord: (record: PiRecord) => void;
  /** Pi exited (never called again for the same process). */
  onExit: (code: number | null, stderrTail: string) => void;
}

/**
 * The `pi --mode rpc` process behind one CodeDen session. A session starts it on demand, waits for
 * its gate to load before anything is sent (a tool call Pi makes without the gate would run
 * unapproved), and starts it again after an exit, resuming Pi's own session file.
 */
export class PiProcess {
  private rpc: PiRpc | undefined;
  private starting: Promise<PiRpc> | undefined;
  private gate: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private gateReady = false;

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: PiProcessConfig,
    private readonly callbacks: PiProcessCallbacks,
  ) {}

  get current(): PiRpc | undefined {
    return this.rpc && !this.rpc.isClosed ? this.rpc : undefined;
  }

  get isGated(): boolean {
    return this.gateReady;
  }

  /** The running Pi, started and gated if needed. */
  async ensure(): Promise<PiRpc> {
    if (this.current) return this.current as PiRpc;
    this.starting ??= this.spawn().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Orderly shutdown (Pi disposes its runtime); the tree is ended if it lingers. */
  async close(): Promise<void> {
    const rpc = this.rpc ?? (await this.starting?.catch(() => undefined));
    this.rpc = undefined;
    await rpc?.close();
  }

  private async spawn(): Promise<PiRpc> {
    const child = spawnResolved(this.config.executable, this.args(), {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: piEnv(this.opts.env),
    });
    const gate = gatePromise();
    this.gate = gate;
    this.gateReady = false;
    const rpc = new PiRpc(
      child,
      {
        onRecord: (record) => this.onRecord(record),
        onExit: (code, stderrTail) => {
          this.rpc = undefined;
          // A gate that never loaded can't be waited for any more.
          this.gate?.reject(
            new ProviderSessionError(
              "gate_missing",
              `Pi exited (code ${code ?? "unknown"}) before it loaded CodeDen's permission gate${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`,
              "setup",
            ),
          );
          this.callbacks.onExit(code, stderrTail);
        },
      },
      "Pi",
    );
    this.rpc = rpc;
    try {
      await this.waitForGate(gate.promise, rpc);
    } catch (error) {
      this.rpc = undefined;
      await rpc.close();
      throw error;
    }
    return rpc;
  }

  private onRecord(record: PiRecord): void {
    if (
      record.type === "extension_ui_request" &&
      record.method === "setStatus" &&
      record.statusKey === GATE_STATUS_KEY
    ) {
      this.gateReady = true;
      this.gate?.resolve();
    }
    this.callbacks.onRecord(record);
  }

  /**
   * Refuse a session Pi started without CodeDen's gate: a tool call would otherwise run without
   * an approval, which is worse than no session at all.
   */
  private async waitForGate(ready: Promise<void>, rpc: PiRpc): Promise<void> {
    const timeoutMs = this.config.startTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ProviderSessionError(
              "gate_missing",
              `Pi did not load CodeDen's permission gate within ${Math.round(timeoutMs / 1000)}s, so its tool calls could not be approved`,
              "setup",
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
    });
    const exited = rpc.whenClosed().then(() => {
      throw new ProviderSessionError("provider_exited", "Pi exited while starting", "setup");
    });
    try {
      await Promise.race([ready, timeout, exited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The argv for this session: its own files and gate, the role prompt, model and resume token. */
  private args(): string[] {
    const args = [
      "--mode",
      "rpc",
      // CodeDen's own folder: the user's Pi session list stays their own.
      "--session-dir",
      this.config.sessionDir,
      // The gate and CodeDen's MCP server.
      "--extension",
      this.config.extensionPath,
      // A fresh worktree is not a trusted project: repo-local Pi resources must not run code here.
      "--no-approve",
    ];
    const systemPrompt = this.opts.systemPrompt?.trim();
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    const chosen = this.config.model();
    if (chosen) {
      const split = splitModelId(chosen);
      if (split.provider) args.push("--provider", split.provider, "--model", split.modelId);
      else args.push("--model", chosen);
    }
    if (this.opts.effort) args.push("--thinking", this.opts.effort);
    if (this.opts.resumeToken) args.push("--session", this.opts.resumeToken);
    return args;
  }
}

function gatePromise(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody awaits yet (the session failed before it waited) is not an error to report.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
