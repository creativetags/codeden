import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ItemOf, RuntimeResponse, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProviderSession, ProviderSessionError } from "../src/adapter";
import { PiAdapter } from "../src/pi/adapter";
import { validateEventStream } from "../src/replay/validate";

const fakePi = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-pi", "pi.mjs"),
};

type Logged = Record<string, unknown>;
let dir: string;
const home = () => join(dir, "codeden");
const logFile = () => join(dir, "pi.log");
const argvFile = () => join(dir, "pi-argv.json");
const logged = (): Logged[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Logged)
    : [];
const received = (type: string): Logged[] =>
  logged()
    .map((entry) => entry.received as Logged | undefined)
    .filter((entry): entry is Logged => entry?.type === type);

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), "codeden-pi-test-"));
  return dir;
}

/** A session's options with a scripted Pi turn (`steps`), logged and isolated per test. */
function options(steps: unknown[], extra: Partial<SessionOptions> = {}): SessionOptions {
  const script = join(dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(script, JSON.stringify(steps));
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    codedenHome: home(),
    systemPrompt: "You are CodeDen's agent.",
    ...extra,
    env: {
      FAKE_PI_LOG: logFile(),
      FAKE_PI_ARGV: argvFile(),
      FAKE_PI_SCRIPT: script,
      ...extra.env,
    },
  };
}

const isTurnEnd = (e: AgentEvent) =>
  e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";

type Request = ItemOf<"approval_request"> | ItemOf<"user_question">;

/** Reads a session's events, answering approvals with `answer`. */
class Reader {
  readonly all: AgentEvent[] = [];
  private readonly it: AsyncIterator<AgentEvent>;
  answer: (item: Request) => RuntimeResponse | undefined = () => ({
    kind: "approval",
    decision: "allow_once",
  });

  constructor(private readonly session: ProviderSession) {
    this.it = session.events[Symbol.asyncIterator]();
  }

  async until(match: (e: AgentEvent) => boolean): Promise<AgentEvent> {
    for (;;) {
      const next = await this.it.next();
      if (next.done) throw new Error("event stream ended");
      const e = next.value;
      this.all.push(e);
      if (
        e.type === "item.started" &&
        (e.item.kind === "approval_request" || e.item.kind === "user_question")
      ) {
        const response = this.answer(e.item);
        if (response) await this.session.respond(e.item.requestId, response);
      }
      if (match(e)) return e;
    }
  }

  async turn(text: string): Promise<AgentEvent[]> {
    const from = this.all.length;
    await this.session.send({ text, attachments: [] });
    await this.until(isTurnEnd);
    return this.all.slice(from);
  }
}

const sessions: ProviderSession[] = [];
async function open(steps: unknown[], extra: Partial<SessionOptions> = {}) {
  const adapter = new PiAdapter({ executable: fakePi });
  const session = await adapter.openSession(options(steps, extra));
  sessions.push(session);
  return { session, reader: new Reader(session), adapter };
}

/** A scripted turn: a text answer with usage and a clean settle. */
const answerTurn = (text = "Done.", input = 100, output = 5) => [
  { event: { type: "message_start", message: { role: "assistant", content: [] } } },
  {
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    },
  },
  {
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text }],
        usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } },
        stopReason: "stop",
      },
    },
  },
  { event: { type: "agent_settled", aborted: false } },
];

/** A turn that calls one tool through the gate. */
/** A turn that calls one tool through the gate: Pi starts the call, then its gate asks CodeDen. */
const toolTurn = (
  gate: { toolCallId: string; toolName: string; input: Record<string, unknown> },
  text = "Ran it.",
) => [
  { event: { type: "message_start", message: { role: "assistant", content: [] } } },
  { event: { type: "tool_execution_start", ...gate, args: gate.input } },
  { gate },
  ...answerTurn(text),
];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const session of sessions.splice(0)) await session.close();
});

describe("Pi sessions", () => {
  it("runs a turn through Pi's RPC mode and reports the session", async () => {
    setup();
    const { session, reader, adapter } = await open(answerTurn("Hello there."));

    const events = await reader.turn("Say hi");
    const assistant = events.find(
      (e) => e.type === "item.completed" && e.item.kind === "assistant_message",
    );
    expect(assistant).toMatchObject({ item: { text: "Hello there.", status: "completed" } });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
    expect(events.filter((e) => e.type === "usage.updated").at(-1)).toMatchObject({
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        costUsd: 0.002,
        contextTokens: 105,
        contextWindow: 200000,
      },
    });
    const updates = reader.all.filter((e) => e.type === "session.updated");
    expect(updates[0]).toMatchObject({
      resumeToken: "/tmp/codeden-pi/fake-session-1.jsonl",
      model: "anthropic/claude-sonnet-4-20250514",
    });
    expect(updates[1]).toMatchObject({ commands: [{ name: "fix-tests" }, { name: "review" }] });
    expect(session.resumeToken()).toBe("/tmp/codeden-pi/fake-session-1.jsonl");
    expect(validateEventStream(reader.all)).toEqual([]);

    // CodeDen runs Pi for this session only: its own session folder, its gate, and no trust in
    // the worktree's own Pi resources. The role prompt goes in Pi's own system prompt.
    const argv = JSON.parse(readFileSync(argvFile(), "utf8")) as string[];
    expect(argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(argv).toContain("--no-approve");
    expect(argv[argv.indexOf("--session-dir") + 1]).toBe(join(home(), "pi", "sessions"));
    expect(argv[argv.indexOf("--extension") + 1]).toMatch(/s1\.extension\.ts$/);
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("You are CodeDen's agent.");
    expect(argv).not.toContain("--session");
    expect(adapter.models()[0]).toMatchObject({
      id: "anthropic/claude-sonnet-4-20250514",
      label: "Claude Sonnet 4",
      isDefault: true,
      efforts: ["low", "medium", "high"],
      contextWindow: 200000,
    });
  });

  it("asks the policy before a tool runs, and the user when the level needs them", async () => {
    setup();
    const { reader } = await open(
      toolTurn({ toolCallId: "tc1", toolName: "bash", input: { command: "ls -la" } }),
      {
        autonomy: "supervised",
      },
    );

    const events = await reader.turn("List the files");
    const approval = events.find(
      (e) => e.type === "item.started" && e.item.kind === "approval_request",
    );
    expect(approval).toMatchObject({
      item: { action: "command", command: "ls -la", toolCallItemId: "tool-tc1" },
    });
    const tool = events.find((e) => e.type === "item.completed" && e.item.kind === "tool_call");
    expect(tool).toMatchObject({
      item: { toolKind: "command", command: "ls -la", status: "completed" },
    });
    // The gate got the policy's answer, and the transcript records who decided it.
    expect(logged().find((entry) => entry.gate)).toMatchObject({
      answer: { value: JSON.stringify({ decision: "allow_once" }) },
    });
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "approval_request"),
    ).toMatchObject({
      item: { decision: "allow_once", decidedBy: "user" },
    });
  });

  it("refuses an edit in a read-only session, with the reason for the model", async () => {
    setup();
    const { reader } = await open(
      toolTurn({ toolCallId: "tc2", toolName: "write", input: { path: "a.txt", content: "x" } }),
      { autonomy: "read_only" },
    );

    const events = await reader.turn("Write a file");
    // A refusal the policy makes on the spot: recorded as declined, never shown as a question.
    expect(
      events.find((e) => e.type === "item.started" && e.item.kind === "approval_request"),
    ).toBeUndefined();
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "approval_request"),
    ).toMatchObject({
      item: { status: "declined", decision: "deny", decidedBy: "policy" },
    });
    const answer = JSON.parse(
      String(
        (logged().find((entry) => entry.gate)?.answer as { value?: string } | undefined)?.value,
      ),
    ) as { decision: string; reason?: string };
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toMatch(/read-only/i);
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "tool_call"),
    ).toMatchObject({
      item: { toolKind: "file_edit", status: "failed" },
    });
  });

  it("lets CodeDen's own MCP tools run without asking", async () => {
    setup();
    const codeden = {
      transport: "http" as const,
      name: "codeden",
      url: "http://127.0.0.1:4000/mcp",
      headers: { Authorization: "Bearer test" },
      trusted: true,
    };
    const { reader } = await open(
      toolTurn({
        toolCallId: "tc3",
        toolName: "mcp__codeden__finish",
        input: { summary: "done" },
      }),
      { autonomy: "supervised", mcpServers: [codeden] },
    );

    const events = await reader.turn("Finish");
    expect(
      events.find((e) => e.type === "item.started" && e.item.kind === "approval_request"),
    ).toBeUndefined();
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "tool_call"),
    ).toMatchObject({
      item: { toolKind: "mcp", server: "codeden", tool: "finish", status: "completed" },
    });
    expect(logged().find((entry) => entry.gate)).toMatchObject({
      answer: { value: JSON.stringify({ decision: "allow_once" }) },
    });
  });

  it("interrupts a running turn with Pi's abort", async () => {
    setup();
    const { session, reader } = await open([{ event: { type: "agent_start" } }, { hang: true }]);

    const from = reader.all.length;
    await session.send({ text: "Long job", attachments: [] });
    await reader.until((e) => e.type === "item.started" || e.type === "turn.completed");
    await session.interrupt();
    const end = await reader.until(isTurnEnd);
    expect(end).toMatchObject({ type: "turn.interrupted", reason: "user" });
    expect(received("abort")).toHaveLength(1);
    // Pi also stops an automatic retry or compaction recovery it would otherwise continue.
    expect(received("abort_retry")).toHaveLength(1);
    expect(reader.all.slice(from).filter((e) => e.type === "turn.failed")).toEqual([]);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("compacts on demand as a turn of its own, with Pi's notices", async () => {
    setup();
    const { session, reader } = await open(answerTurn("ok"));

    const from = reader.all.length;
    await session.compact?.();
    await reader.until(isTurnEnd);
    const events = reader.all.slice(from);
    expect(events.map((e) => (e.type === "item.completed" ? e.item.kind : e.type))).toContain(
      "notice",
    );
    // One notice, opened by "compacting" and completed by the outcome.
    expect(
      events.find(
        (e) =>
          e.type === "item.completed" && e.item.kind === "notice" && e.item.code === "compacting",
      ),
    ).toBeUndefined();
    expect(events.find((e) => e.type === "item.started")).toMatchObject({
      item: { kind: "notice", code: "compacting", status: "in_progress" },
    });
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "notice"),
    ).toMatchObject({
      item: { code: "context_compacted", message: "Context compacted", status: "completed" },
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("refuses to run when Pi starts without CodeDen's gate", async () => {
    setup();
    const adapter = new PiAdapter({ executable: fakePi, startTimeoutMs: 300 });
    const session = await adapter
      .openSession(options(answerTurn(), { env: { FAKE_PI_NO_GATE: "1" } }))
      .catch((error: unknown) => error);
    expect(session).toBeInstanceOf(ProviderSessionError);
    expect(session).toMatchObject({ code: "gate_missing", kind: "setup" });
  });

  it("resumes Pi's own session file", async () => {
    setup();
    const token = "/tmp/codeden-pi/earlier.jsonl";
    const { session } = await open(answerTurn(), { resumeToken: token });
    const argv = JSON.parse(readFileSync(argvFile(), "utf8")) as string[];
    expect(argv[argv.indexOf("--session") + 1]).toBe(token);
    expect(session.resumeToken()).toBe("/tmp/codeden-pi/fake-session-1.jsonl");
  });

  it("refuses a command Pi will not accept, as a failed turn", async () => {
    setup();
    const { session, reader } = await open(answerTurn(), { env: { FAKE_PI_FAIL_PROMPT: "1" } });
    await session.send({ text: "Hi", attachments: [] });
    const end = await reader.until(isTurnEnd);
    expect(end).toMatchObject({ type: "turn.failed", error: { code: "prompt_failed" } });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("refreshes the model list without a session", async () => {
    setup();
    const adapter = new PiAdapter({ executable: fakePi });
    // A given copy has no version, so the refresh talks to Pi directly.
    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(adapter.models().map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "openai/gpt-5.6",
    ]);
    expect(adapter.models()[0]).toMatchObject({ isDefault: true, contextWindow: 200000 });
    expect(adapter.models()[1]).toMatchObject({ efforts: ["low", "high", "xhigh"] });
  });

  it("reports Pi's own context figure for the conversation", async () => {
    setup();
    const { session, reader } = await open(answerTurn(), {
      env: {
        FAKE_PI_STATS: JSON.stringify({
          contextUsage: { tokens: 2_400, contextWindow: 150_000, percent: 1.6 },
        }),
      },
    });

    await session.send({ text: "Say hi", attachments: [] });
    await reader.until(isTurnEnd);
    // After the turn's own figures: a turn-less report, since it describes the conversation, so
    // the session keeps Pi's exact context size rather than the sum of the turn's messages.
    const report = await reader.until(
      (e) => e.type === "usage.updated" && e.usage.contextTokens === 2_400,
    );
    expect(report).toMatchObject({ usage: { contextWindow: 150_000 } });
    expect(report).not.toHaveProperty("turnId");
  });

  it("streams a running tool's output into its item", async () => {
    setup();
    const call = { toolCallId: "tc9", toolName: "bash", input: { command: "make" } };
    const { reader } = await open([
      { event: { type: "tool_execution_start", ...call, args: call.input } },
      {
        event: {
          type: "tool_execution_update",
          ...call,
          args: call.input,
          partialResult: { content: [{ type: "text", text: "compiling…" }] },
        },
      },
      {
        event: {
          type: "tool_execution_end",
          ...call,
          args: call.input,
          result: { content: [{ type: "text", text: "done" }] },
          isError: false,
          durationMs: 5,
        },
      },
      ...answerTurn("Built it."),
    ]);

    const events = await reader.turn("Build it");
    const update = events.find((e) => e.type === "item.updated");
    expect(update).toMatchObject({
      item: { id: "tool-tc9", status: "in_progress", output: { text: "compiling…" } },
    });
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "tool_call"),
    ).toMatchObject({ item: { id: "tool-tc9", status: "completed" } });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("asks the user a dialog from one of their own Pi extensions", async () => {
    setup();
    const { reader } = await open([
      { dialog: { method: "select", title: "Deploy where?", options: ["staging", "production"] } },
      ...answerTurn("Asked."),
    ]);
    reader.answer = (item) =>
      item.kind === "user_question"
        ? { kind: "answer", answers: { answer: ["staging"] } }
        : undefined;

    const events = await reader.turn("Deploy");
    const asked = events.find((e) => e.type === "item.started" && e.item.kind === "user_question");
    expect(asked).toMatchObject({ item: { questions: [{ question: "Deploy where?" }] } });
    const question =
      asked?.type === "item.started" && asked.item.kind === "user_question"
        ? asked.item.questions[0]
        : undefined;
    expect(question?.options.map((o) => o.label)).toEqual(["staging", "production"]);
    expect(question?.allowFreeText).toBe(false);
    // The answer goes back in the shape Pi's extension API expects (a `select` takes a value).
    expect(logged().find((entry) => entry.dialog)).toMatchObject({
      answer: { value: "staging" },
    });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("shows a Pi extension's notification as a notice", async () => {
    setup();
    const { reader } = await open([
      { dialog: { method: "notify", message: "Deploy finished", notifyType: "warning" } },
      ...answerTurn("Done."),
    ]);

    const events = await reader.turn("Deploy");
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "notice"),
    ).toMatchObject({
      item: { level: "warning", code: "extension_notice", message: "Deploy finished" },
    });
  });

  it("refuses edits while planning, and the first change asked is the plan", async () => {
    setup();
    const gate = {
      toolCallId: "tc4",
      toolName: "write",
      input: { path: "a.txt", content: "x" },
    };
    // One turn: the agent writes out its plan, then tries to act on it.
    const { session, reader } = await open(
      [
        ...answerTurn("The plan is: write a.txt.").slice(0, -1),
        { event: { type: "tool_execution_start", ...gate, args: gate.input } },
        { gate },
        { event: { type: "agent_settled", aborted: false } },
      ],
      { autonomy: "auto" },
    );
    await session.setPlanMode?.(true);
    // The turn's message says plan mode is on, so the model knows before it tries anything.
    reader.answer = (item) =>
      item.kind === "approval_request" && item.action === "plan"
        ? { kind: "approval", decision: "allow_once" }
        : { kind: "approval", decision: "deny" };

    const planned = await reader.turn("Plan how to do it");
    // The agent's own answer is the plan on the card.
    expect(
      planned.find((e) => e.type === "item.completed" && e.item.kind === "plan"),
    ).toMatchObject({ item: { text: "The plan is: write a.txt." } });
    expect(
      planned.find((e) => e.type === "item.started" && e.item.kind === "approval_request"),
    ).toMatchObject({ item: { action: "plan", title: "Implement the plan" } });
    // Approving ends plan mode and lets the change run.
    expect(reader.all.filter((e) => e.type === "session.updated").at(-1)).toMatchObject({
      planMode: false,
    });
    expect(
      planned.find((e) => e.type === "item.completed" && e.item.kind === "tool_call"),
    ).toMatchObject({ item: { status: "completed" } });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("names Pi's own session file", async () => {
    setup();
    const { session } = await open(answerTurn());
    await session.setTitle?.("Fix the failing tests");
    const named = received("set_session_name").at(-1);
    expect(named).toMatchObject({ name: "Fix the failing tests" });
  });

  it("forks the conversation into a new session file", async () => {
    setup();
    const adapter = new PiAdapter({ executable: fakePi });
    // The fork runs in its own short-lived process, which takes the runner's environment.
    vi.stubEnv("FAKE_PI_LOG", logFile());
    const entries = [
      { type: "message", id: "e1", parentId: null, message: { role: "user", content: "One" } },
      { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [] } },
      { type: "message", id: "e3", parentId: "e2", message: { role: "user", content: "Two" } },
      { type: "message", id: "e4", parentId: "e3", message: { role: "assistant", content: [] } },
    ];
    vi.stubEnv("FAKE_PI_ENTRIES", JSON.stringify(entries));

    const whole = await adapter.forkConversation("/tmp/codeden-pi/s1.jsonl", { cwd: dir });
    expect(whole).toBe("/tmp/codeden-pi/fake-session-clone-1.jsonl");
    // Ending with e2's turn: Pi forks from the next user message, which leaves e3 out.
    const upto = await adapter.forkConversation("/tmp/codeden-pi/s1.jsonl", {
      cwd: dir,
      upTo: "e2",
    });
    expect(upto).toBe("/tmp/codeden-pi/fake-session-fork-1.jsonl");
    expect(logged().filter((entry) => entry.copy)).toEqual([
      { copy: "clone", entryId: undefined },
      { copy: "fork", entryId: "e3" },
    ]);
    // The last turn of the branch has nothing after it, so the whole branch is the copy.
    const last = await adapter.forkConversation("/tmp/codeden-pi/s1.jsonl", {
      cwd: dir,
      upTo: "e4",
    });
    expect(last).toBe("/tmp/codeden-pi/fake-session-clone-1.jsonl");

    await expect(
      adapter.forkConversation("/tmp/codeden-pi/s1.jsonl", { cwd: dir, upTo: "gone" }),
    ).rejects.toMatchObject({ code: "fork_point_missing" });
  });

  it("answers a side job through Pi's print mode", async () => {
    setup();
    vi.stubEnv("FAKE_PI_LOG", logFile());
    const adapter = new PiAdapter({ executable: fakePi });
    const text = await adapter.utilityModel?.().runOneShot({ prompt: "Title this session" });
    expect(text).toBe("A short title");
    const printed = logged().find((entry) => entry.print)?.print as string[];
    expect(printed).toContain("--print");
    expect(printed).toContain("--no-tools");
    expect(printed).toContain("--no-session");
    expect(printed.at(-1)).toBe("Title this session");
  });
});
