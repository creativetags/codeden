import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type AutonomyLevel,
  type ErrorKind,
  oneLineDescription,
  type RuntimeResponse,
  type SessionOptions,
  type UserInput,
} from "@codeden/contracts";
import { classifyAcpError } from "../acp/errors";
import { type AcpPolicy, policyFor, trustedServers } from "../acp/policy";
import { type ProviderSession, ProviderSessionError, type SessionConfigChange } from "../adapter";
import { ApprovalBroker } from "../approvals";
import { AsyncQueue } from "../async-queue";
import { explicitModel } from "../util/model";
import { PiChange } from "./change";
import { replyToDialog } from "./gate";
import { PiEventMapper } from "./mapper";
import { modelTakesImages } from "./models";
import { PiProcess, type PiProcessConfig } from "./process";
import { promptFor } from "./prompt";
import type {
  PiCommand,
  PiCommandInfo,
  PiExtensionUiRequest,
  PiModel,
  PiRecord,
  PiSessionEvent,
  PiState,
} from "./protocol";
import type { PiRpc } from "./rpc";

export interface PiSessionConfig extends Omit<PiProcessConfig, "model"> {
  /** How long a Stop waits for Pi to settle before the turn is ended anyway. */
  interruptTimeoutMs?: number;
  /** The context window of a model (CodeDen id), for usage and the context figure. */
  contextWindow?: (model: string | undefined) => number | undefined;
}

/**
 * A session on Pi (`pi --mode rpc`, §7.2): one process per CodeDen session. Every tool call Pi
 * makes goes through CodeDen's gate extension and the session's policy (§11.2), so autonomy
 * changes reach the next call; CodeDen's MCP server is registered by the same extension. A resumed
 * session is Pi's own session file (`--session`), never a copy. When the process exits, the next
 * message starts it again and resumes.
 */
export class PiSession implements ProviderSession {
  readonly events = new AsyncQueue<AgentEvent>();
  private readonly mapper: PiEventMapper;
  private readonly broker: ApprovalBroker;
  private readonly policy: AcpPolicy;
  private readonly trusted: string[];
  private readonly mcpServers: string[];
  private readonly process: PiProcess;
  private closed = false;
  private turnPending = false;
  private interrupted = false;
  private sessionFile: string | undefined;
  private model: string | undefined;
  /** The model Pi runs, as Pi defines it (for the adapter's model list). */
  private current: PiModel | undefined;
  private readonly change = new PiChange();
  /** What the session's model takes as input, from Pi's own model definition. */
  private images = true;
  private modelInfos: PiModel[] = [];

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: PiSessionConfig,
  ) {
    const emit = (event: AgentEvent) => {
      if (
        (event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted") &&
        event.threadId === this.mapper.threadId
      ) {
        this.turnPending = false;
      }
      this.events.push(event);
    };
    this.mcpServers = opts.mcpServers.map((s) => s.name);
    this.trusted = trustedServers(opts);
    this.mapper = new PiEventMapper({
      sessionId: opts.sessionId,
      emit,
      tools: { cwd: opts.cwd, mcpServers: this.mcpServers },
      contextWindow: () => config.contextWindow?.(this.model),
      onModel: (model) => {
        this.model = model;
      },
    });
    this.broker = new ApprovalBroker(emit);
    this.policy = policyFor(opts);
    this.model = explicitModel(opts.model);
    this.process = new PiProcess(
      opts,
      { ...config, model: () => this.model },
      {
        onRecord: (record) => this.onRecord(record),
        onExit: (code, stderrTail) => this.onExit(code, stderrTail),
      },
    );
  }

  /** Start Pi, wait for its gate, and report the session's resume token. */
  async start(): Promise<void> {
    this.events.push({ type: "thread.started", thread: { id: this.mapper.threadId } });
    await this.ensureStarted();
  }

  resumeToken(): string | undefined {
    return this.sessionFile;
  }

  /** The models Pi listed for this session's process, for the adapter's catalog. */
  models(): PiModel[] {
    return this.modelInfos;
  }

  /** The model the session runs, as Pi defines it (Pi's own default until one is chosen). */
  currentModel(): PiModel | undefined {
    return this.current;
  }

  async setAutonomy(level: AutonomyLevel): Promise<void> {
    this.policy.setAutonomy(level);
  }

  /** Model and effort changes apply from the next turn: Pi's process keeps its own selection. */
  async configure(change: SessionConfigChange): Promise<void> {
    this.change.set(change);
  }

  async send(input: UserInput): Promise<void> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.turnPending || this.mapper.currentTurnId) {
      throw new ProviderSessionError("turn_running", "A turn is already running");
    }
    // Built before the turn opens: a message CodeDen can't turn into Pi input fails without one.
    let prompt: ReturnType<typeof promptFor>;
    try {
      prompt = promptFor(input, this.images);
    } catch (error) {
      throw new ProviderSessionError("bad_input", messageOf(error));
    }
    this.turnPending = true;
    let rpc: PiRpc;
    try {
      rpc = await this.ensureStarted();
      await this.change.apply(rpc, {
        onModel: (model) => this.onModel(model),
        onFailure: (code, message) => this.mapper.notice("warning", code, message),
      });
    } catch (error) {
      this.turnPending = false;
      throw error;
    }
    this.interrupted = false;
    this.mapper.beginTurn(`turn-${randomUUID()}`);
    this.mapper.userMessage(input);
    try {
      await rpc.request({
        type: "prompt",
        message: prompt.message,
        ...(prompt.images.length ? { images: prompt.images } : {}),
      });
    } catch (error) {
      this.mapper.endTurn({ type: "failed", error: promptFailure(error) });
    }
  }

  async steer(input: UserInput): Promise<void> {
    if (!this.mapper.currentTurnId) {
      throw new ProviderSessionError("no_turn", "No turn is running to steer");
    }
    const rpc = this.process.current;
    if (!rpc) throw new ProviderSessionError("no_turn", "Pi is not running");
    try {
      await rpc.request({ type: "steer", message: input.text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderSessionError("steer_failed", message);
    }
  }

  /** `abort`: Pi ends the run and answers once it is idle. A Stop that never settles ends the turn. */
  async interrupt(): Promise<void> {
    const turnId = this.mapper.currentTurnId;
    if (!turnId) return;
    this.interrupted = true;
    this.broker.cancelAll();
    void this.process.current?.request({ type: "abort" }).catch(() => undefined);
    setTimeout(() => {
      if (this.mapper.currentTurnId === turnId) {
        this.mapper.endTurn({ type: "interrupted", reason: "user" });
      }
    }, this.config.interruptTimeoutMs ?? 10_000).unref();
  }

  /**
   * Compact now, as a turn of its own: Pi compacts the conversation and reports
   * `compaction_start`/`compaction_end`, whose notices the turn holds.
   */
  async compact(): Promise<void> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.turnPending || this.mapper.currentTurnId) {
      throw new ProviderSessionError("turn_running", "A turn is already running");
    }
    this.turnPending = true;
    let rpc: PiRpc;
    try {
      rpc = await this.ensureStarted();
    } catch (error) {
      this.turnPending = false;
      throw error;
    }
    this.mapper.beginTurn(`turn-${randomUUID()}`);
    try {
      await rpc.request({ type: "compact" });
      this.mapper.endTurn({ type: "completed" });
    } catch (error) {
      this.mapper.endTurn({ type: "failed", error: promptFailure(error) });
    }
  }

  async respond(requestId: string, response: RuntimeResponse): Promise<void> {
    this.broker.respond(requestId, response);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.broker.cancelAll();
    await this.process.close();
    this.events.close();
  }

  /** Start Pi (or reuse the running one), then learn its state, models and `/` commands. */
  private async ensureStarted(): Promise<PiRpc> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    const rpc = await this.process.ensure();
    if (this.sessionFile === undefined) {
      const state = await rpc.request<PiState>({ type: "get_state" }).catch(() => undefined);
      this.onState(state);
      // Awaited: the adapter's model list and the composer's commands are ready with the session.
      await this.loadModels(rpc);
      await this.loadCommands(rpc);
    }
    return rpc;
  }

  private onRecord(record: PiRecord): void {
    if (record.type === "extension_ui_request") {
      void this.onExtensionUi(record);
      return;
    }
    if (record.type === "extension_error") {
      this.onExtensionError(record);
      return;
    }
    const event = record as PiSessionEvent;
    this.mapper.handle(event);
    if (event.type === "agent_settled") this.finishTurn(event.aborted === true);
  }

  /**
   * An extension asking for something: CodeDen's gate sends each tool call as an `input` dialog,
   * which the session's policy answers; every other dialog belongs to an extension CodeDen has no
   * UI for, so it is cancelled.
   */
  private async onExtensionUi(request: PiExtensionUiRequest): Promise<void> {
    const reply = await replyToDialog(request, {
      broker: this.broker,
      policy: this.policy,
      cwd: this.opts.cwd,
      mcpServers: this.mcpServers,
      trustedServers: this.trusted,
      ctx: this.mapper.currentTurnId
        ? { threadId: this.mapper.threadId, turnId: this.mapper.currentTurnId }
        : undefined,
    });
    if (!reply) return; // A fire-and-forget call expects nothing back.
    this.process.current?.answer(request.id, {
      type: "extension_ui_response",
      id: request.id,
      ...("answer" in reply ? { value: JSON.stringify(reply.answer) } : { cancelled: true }),
    });
  }

  private onExtensionError(record: {
    extensionPath?: string;
    event?: string;
    error?: string;
  }): void {
    const message = `${record.extensionPath ?? "An extension"} failed on ${record.event ?? "an event"}: ${record.error ?? "unknown error"}`;
    this.mapper.notice("warning", "extension_error", message);
  }

  private finishTurn(aborted: boolean): void {
    const failure = this.mapper.turnFailure;
    if (failure) {
      this.mapper.endTurn({ type: "failed", error: failure });
      return;
    }
    if (aborted) {
      this.mapper.endTurn({ type: "interrupted", reason: this.interrupted ? "user" : "provider" });
      return;
    }
    const stopReason = this.mapper.stopReason;
    this.mapper.endTurn({ type: "completed", ...(stopReason ? { stopReason } : {}) });
  }

  private onExit(code: number | null, stderrTail: string): void {
    if (this.closed) return;
    if (this.mapper.currentTurnId) {
      this.mapper.endTurn({
        type: "failed",
        error: {
          code: "provider_exited",
          kind: "transient",
          retryable: true,
          message: `Pi exited (code ${code ?? "unknown"})`,
          ...(stderrTail ? { detail: stderrTail.slice(-2000) } : {}),
        },
      });
    }
  }

  private onState(state: PiState | undefined): void {
    if (!state) return;
    if (state.sessionFile) this.sessionFile = state.sessionFile;
    if (state.model) this.onModel(state.model);
    this.events.push({
      type: "session.updated",
      ...(this.sessionFile ? { resumeToken: this.sessionFile } : {}),
      ...(this.model ? { model: this.model } : {}),
    });
  }

  private onModel(model: PiModel | undefined): void {
    if (!model?.id) return;
    this.images = modelTakesImages(model);
    this.current = model;
    this.model = `${model.provider}/${model.id}`;
  }

  /** Pi's models, for the adapter's catalog: the account's list, kept for the next session. */
  private async loadModels(rpc: PiRpc): Promise<void> {
    const data = await this.ask<{ models?: PiModel[] }>(rpc, { type: "get_available_models" });
    // The fallback list stands in when Pi doesn't answer (the model picker's "Default").
    this.modelInfos = (data?.models ?? []).filter((m) => m?.id && m?.provider);
  }

  /** Pi's `/` commands: its extensions' commands, prompt templates and skills. */
  private async loadCommands(rpc: PiRpc): Promise<void> {
    const data = await this.ask<{ commands?: PiCommandInfo[] }>(rpc, { type: "get_commands" });
    const commands = (data?.commands ?? [])
      .filter((c) => typeof c?.name === "string" && c.name)
      .map((c) => ({ name: c.name, description: oneLineDescription(c.description ?? "") }));
    if (!commands.length) return;
    this.events.push({ type: "session.updated", commands });
  }

  /**
   * A question about the session that must not hold the start up: Pi answers these from its own
   * configuration, but a slow extension discovery shouldn't refuse a session.
   */
  private async ask<T>(rpc: PiRpc, command: PiCommand, ms = 10_000): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([rpc.request<T>(command), timeout]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A refused command or a failed turn as the turn's error. */
function promptFailure(error: unknown): { code: string; message: string; kind: ErrorKind } {
  return { code: "prompt_failed", message: messageOf(error), kind: classifyAcpError(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
