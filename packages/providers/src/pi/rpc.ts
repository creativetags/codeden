import type { ChildProcess } from "node:child_process";
import { killTree } from "../util/exec";
import type { PiCommand, PiExtensionUiResponse, PiRecord, PiResponse } from "./protocol";

/** A command Pi refused, or one it never answered because the process is gone. */
export class PiRpcError extends Error {
  constructor(
    message: string,
    /** The command that failed, e.g. `set_model`. */
    readonly command?: string,
  ) {
    super(message);
    this.name = "PiRpcError";
  }
}

export interface PiRpcHandlers {
  /** Every record that is not a command response: a session event or an extension's call. */
  onRecord: (record: PiRecord) => void;
  onExit: (code: number | null, stderrTail: string) => void;
}

/**
 * Pi in RPC mode over stdio (`pi --mode rpc`, rpc.md): JSONL records on stdin and stdout, logs on
 * stderr (kept as a short tail for error reports, never parsed). Command responses are correlated
 * by the id CodeDen gives each command, since Pi handles them asynchronously.
 */
export class PiRpc {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void }
  >();
  private stdoutBuffer = "";
  private stderrTail = "";
  private exited = false;
  /** Resolvers for `whenClosed()`, woken when the process exits. */
  private readonly exitWaiters: Array<() => void> = [];

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: PiRpcHandlers,
    private readonly label = "Pi",
  ) {
    const stdout = child.stdout;
    if (!stdout || !child.stdin) throw new Error(`${label} needs piped stdio`);
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.on("exit", (code) => this.onExit(code));
    child.on("error", (error) => {
      this.stderrTail += `\n${error.message}`;
      this.onExit(null);
    });
  }

  get isClosed(): boolean {
    return this.exited;
  }

  /** Run a command and wait for its response's `data`. Rejects when Pi refuses or has exited. */
  request<T>(command: PiCommand): Promise<T> {
    if (this.exited) {
      return Promise.reject(new PiRpcError(`${this.label} is not running`, command.type));
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
      this.write({ id, ...command });
    });
  }

  /** Resolves when Pi has exited (immediately when it already has). */
  whenClosed(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise<void>((resolve) => this.exitWaiters.push(resolve));
  }

  /** Answer a dialog `extension_ui_request`. */
  answer(id: string, response: PiExtensionUiResponse): void {
    this.write({ ...response, id });
  }

  /** Stop Pi: close stdin (an orderly shutdown), then end the process if it lingers. */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    const exited = new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      setTimeout(() => resolve(), 5000).unref();
    });
    for (const pending of this.pending.values()) {
      pending.reject(new PiRpcError(`${this.label} was closed`));
    }
    this.pending.clear();
    try {
      this.child.stdin?.end();
    } catch {
      // Already gone.
    }
    setTimeout(() => {
      if (!this.exited) killTree(this.child);
    }, 1500).unref();
    return exited;
  }

  private write(record: object): void {
    if (this.exited) return;
    this.child.stdin?.write(`${JSON.stringify(record)}\n`);
  }

  /**
   * Split the stream on LF only. Pi's docs warn off `readline`: it also breaks on U+2028 and
   * U+2029, which are legal inside JSON strings.
   */
  private onData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.trim()) this.onLine(line);
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // A stray print, not a protocol record.
    }
    if (!record || typeof record !== "object" || typeof record.type !== "string") return;
    if (record.type === "response") {
      this.onResponse(record as unknown as PiResponse);
      return;
    }
    this.handlers.onRecord(record as unknown as PiRecord);
  }

  private onResponse(response: PiResponse): void {
    // A parse failure has no id: nothing is waiting on it, and the next command reports its own.
    if (response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.success) pending.resolve(response.data);
    else
      pending.reject(
        new PiRpcError(response.error || `${response.command} failed`, response.command),
      );
  }

  private onExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) {
      pending.reject(new PiRpcError(`${this.label} exited`, undefined));
    }
    this.pending.clear();
    for (const wake of this.exitWaiters.splice(0)) wake();
    this.handlers.onExit(code, this.stderrTail);
  }
}
