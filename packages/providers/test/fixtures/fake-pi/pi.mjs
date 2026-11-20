// A scripted stand-in for Pi in RPC mode (`pi --mode rpc`), in the shapes Pi 1.5 uses. It plays Pi
// with CodeDen's gate extension loaded, so the handshake and the tool-call dialogs are the real
// protocol. No model is ever called.
//   pi.mjs --version                    prints FAKE_PI_VERSION (default 1.5.2)
//   pi.mjs --mode rpc [...]             serves the RPC protocol on stdio
//   pi.mjs --mode rpc --no-session      answers get_state/get_available_models, then idles
// Environment:
//   FAKE_PI_LOG        every record the client sends, every gate answer and every argv, JSONL
//   FAKE_PI_SCRIPT     a JSON file of steps each `prompt` runs in order (see below)
//   FAKE_PI_NO_GATE=1  no gate handshake (a session whose extension never loaded)
//   FAKE_PI_ARGV       the file that gets this process's argv, one JSON array
//   FAKE_PI_FAIL_PROMPT=1  `prompt` answers success:false (a refused command)
// Steps:
//   { "event": {...} }                       one session event on stdout
//   { "gate": { toolCallId, toolName, input, cwd } }
//                                            the gate's approval dialog; waits for the answer
//   { "settle": true }                       agent_settled (the run is over)
//   { "hang": true }                         wait for `abort` (then agent_settled, aborted)
//   { "command": "compact", "events": [...] } a compaction's own events, for the `compact` command
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const env = process.env;
const GATE_KEY = "codeden-gate";

const record = (entry) => {
  if (env.FAKE_PI_LOG) appendFileSync(env.FAKE_PI_LOG, `${JSON.stringify(entry)}\n`);
};

if (env.FAKE_PI_ARGV) writeFileSync(env.FAKE_PI_ARGV, JSON.stringify(args));
if (args[0] === "--version") {
  console.log(env.FAKE_PI_VERSION ?? "1.5.2");
  process.exit(0);
}
if (args[0] !== "--mode" || args[1] !== "rpc") {
  console.error(`Unknown arguments: ${args.join(" ")}`);
  process.exit(1);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessionId = "fake-session-1";
const sessionFile = "/tmp/codeden-pi/fake-session-1.jsonl";
const model = {
  id: "claude-sonnet-4-20250514",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high" },
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 16384,
};

const script = env.FAKE_PI_SCRIPT
  ? JSON.parse(readFileSync(env.FAKE_PI_SCRIPT, "utf8"))
  : [
      {
        event: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      },
      {
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done." },
        },
      },
      {
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: model.id,
            content: [{ type: "text", text: "Done." }],
            usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
            stopReason: "stop",
          },
        },
      },
      { event: { type: "agent_settled", aborted: false } },
    ];

/** The dialogs waiting for an `extension_ui_response`, by id. */
const dialogs = new Map();
let nextDialogId = 1;
let abortRun = () => {};

/** Ask the gate the way Pi's extension API does: an `input` dialog whose answer is JSON. */
function askGate(call) {
  const id = `gate-${nextDialogId++}`;
  return new Promise((resolve) => {
    dialogs.set(id, resolve);
    send({
      type: "extension_ui_request",
      id,
      method: "input",
      title: JSON.stringify({ version: 1, ...call }),
      placeholder: GATE_KEY,
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runScript() {
  let stopped = false;
  abortRun = () => {
    stopped = true;
  };
  for (const step of script) {
    if (stopped) break;
    if (step.gate) {
      // A tool call: Pi's gate asks CodeDen, and a denial is handed back to the model instead.
      const answer = await askGate(step.gate);
      record({ gate: step.gate, answer });
      if (answer?.cancelled) continue;
      const parsed = JSON.parse(answer?.value ?? "{}");
      if (parsed.decision === "allow_once" || parsed.decision === "allow_session") {
        send({
          type: "tool_execution_end",
          toolCallId: step.gate.toolCallId,
          toolName: step.gate.toolName,
          result: { content: [{ type: "text", text: step.result ?? "ok" }] },
          isError: false,
          durationMs: 7,
        });
      } else {
        send({
          type: "tool_execution_end",
          toolCallId: step.gate.toolCallId,
          toolName: step.gate.toolName,
          result: { content: [{ type: "text", text: parsed.reason ?? "denied" }] },
          isError: true,
          durationMs: 1,
        });
      }
      continue;
    }
    if (step.event) {
      send(step.event);
      continue;
    }
    if (step.settle) {
      send({ type: "agent_settled", aborted: stopped });
      return;
    }
    if (step.hang) {
      while (!stopped) await sleep(10);
      send({ type: "agent_settled", aborted: true });
      return;
    }
  }
  if (!script.some((step) => step.settle || step.hang)) {
    send({ type: "agent_settled", aborted: stopped });
  }
}

/** The gate reports it is loaded, as CodeDen's extension does on `session_start`. */
function handshake() {
  if (env.FAKE_PI_NO_GATE === "1") return;
  send({
    type: "extension_ui_request",
    id: "gate-status",
    method: "setStatus",
    statusKey: GATE_KEY,
    statusText: "ready",
  });
}

function answer(id, data) {
  send({ type: "response", id, command: data?.command ?? "unknown", success: data?.success ?? true, data: data?.data });
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      answer(command.id, {
        data: { sessionId, sessionFile, model, thinkingLevel: "medium", isStreaming: false, messageCount: 0 },
      });
      return;
    case "get_available_models":
      answer(command.id, {
        data: {
          models: [
            model,
            {
              id: "gpt-5.6",
              name: "GPT-5.6",
              provider: "openai",
              reasoning: true,
              thinkingLevelMap: { off: "none", low: "low", high: "high", xhigh: "xhigh" },
              input: ["text"],
              contextWindow: 400000,
            },
          ],
        },
      });
      return;
    case "get_available_thinking_levels":
      answer(command.id, { data: { levels: ["off", "low", "medium", "high"] } });
      return;
    case "get_commands":
      answer(command.id, {
        data: {
          commands: [
            { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
            { name: "review", description: "Review the diff", source: "extension" },
          ],
        },
      });
      return;
    case "set_model":
      answer(command.id, { data: { ...model, id: command.modelId, provider: command.provider } });
      return;
    case "set_thinking_level":
      answer(command.id);
      return;
    case "prompt":
      if (env.FAKE_PI_FAIL_PROMPT === "1") {
        answer(command.id, { success: false, command: "prompt" });
        return;
      }
      answer(command.id, { command: "prompt", data: { disposition: "started" } });
      void runScript();
      return;
    case "steer":
      answer(command.id, { data: { disposition: "queued" } });
      return;
    case "abort":
      abortRun();
      answer(command.id);
      return;
    case "compact":
      send({ type: "compaction_start", reason: "manual" });
      send({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "Summary", tokensBefore: 1000, estimatedTokensAfter: 120 },
        aborted: false,
      });
      answer(command.id, { data: { summary: "Summary", tokensBefore: 1000, estimatedTokensAfter: 120 } });
      return;
    default:
      answer(command.id, { success: false, command: command.type ?? "unknown" });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    record({ received: command });
    if (command.type === "extension_ui_response") {
      const resolve = dialogs.get(command.id);
      dialogs.delete(command.id);
      resolve?.(command);
      continue;
    }
    handle(command);
  }
});
process.stdin.on("end", () => process.exit(0));

handshake();
