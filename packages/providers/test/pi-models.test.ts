import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSupportedPiVersion, piTooOldMessage, readPiDefaultModel } from "../src/pi/detect";
import { piEnv } from "../src/pi/env";
import { gateExtensionSource, parseApprovalRequest } from "../src/pi/extension";
import {
  effortsOf,
  fallbackPiModels,
  modelId,
  modelTakesImages,
  piModelList,
  splitModelId,
} from "../src/pi/models";
import { promptFor } from "../src/pi/prompt";
import type { PiModel } from "../src/pi/protocol";

const sonnet: PiModel = {
  id: "claude-sonnet-4-20250514",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high" },
  input: ["text", "image"],
  contextWindow: 200000,
};

const gpt: PiModel = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  provider: "openai",
  reasoning: true,
  thinkingLevelMap: { off: null, low: "low", medium: null, high: "high", xhigh: "xhigh" },
  input: ["text"],
};

describe("Pi model lists", () => {
  it("uses `<provider>/<model>` ids, which split back for `set_model`", () => {
    expect(modelId(sonnet)).toBe("anthropic/claude-sonnet-4-20250514");
    expect(splitModelId("anthropic/claude-sonnet-4-20250514")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    expect(splitModelId("plain")).toEqual({ provider: "", modelId: "plain" });
  });

  it("reports the thinking levels a model supports as efforts", () => {
    expect(effortsOf(sonnet)).toEqual(["low", "medium", "high"]);
    expect(effortsOf(gpt)).toEqual(["low", "high", "xhigh"]);
    expect(effortsOf({ reasoning: false })).toEqual([]);
    // No map: Pi said nothing, so every level the contract knows.
    expect(effortsOf({ reasoning: true })).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("lists the default first, once each, with its context window", () => {
    const models = piModelList([sonnet, gpt, sonnet], gpt);
    expect(models.map((m) => m.id)).toEqual([
      "openai/gpt-5.6",
      "anthropic/claude-sonnet-4-20250514",
    ]);
    expect(models[0]).toMatchObject({
      isDefault: true,
      description: "openai",
    });
    expect(models[1]).toMatchObject({ label: "Claude Sonnet 4", contextWindow: 200000 });
  });

  it("falls back to Pi's own default until it has listed its models", () => {
    expect(fallbackPiModels()).toEqual([
      {
        id: "default",
        label: "Default",
        description:
          "The model configured in Pi (its settings and credentials), or Pi's own default",
        efforts: [],
        isDefault: true,
      },
    ]);
  });

  it("knows which models take images", () => {
    expect(modelTakesImages(sonnet)).toBe(true);
    expect(modelTakesImages(gpt)).toBe(false);
    expect(modelTakesImages(undefined)).toBe(false);
  });
});

describe("Pi's gate extension", () => {
  it("carries CodeDen's MCP servers as mcp.json entries", () => {
    const source = gateExtensionSource([
      {
        transport: "http",
        name: "codeden",
        url: "http://127.0.0.1:4000/mcp",
        headers: { Authorization: "Bearer t" },
        trusted: true,
      },
      {
        transport: "stdio",
        name: "docs",
        command: "docs-mcp",
        args: ["--stdio"],
        env: { TOKEN: "x" },
      },
    ]);
    expect(source).toContain('"codeden": {');
    expect(source).toContain('"url": "http://127.0.0.1:4000/mcp"');
    expect(source).toContain('"Authorization": "Bearer t"');
    expect(source).toContain('"command": "docs-mcp"');
    expect(source).toContain('"args": [\n      "--stdio"\n    ]');
    expect(source).toContain('"env": {\n      "TOKEN": "x"\n    }');
    // The gate: a blocked call is the default answer, so a missing CodeDen never runs a tool.
    expect(source).toContain('const GATE_KEY = "codeden-gate"');
    expect(source).toContain("return { block: true, reason };");
  });

  it("reads the request a gate dialog carries back", () => {
    const request = {
      version: 1,
      toolCallId: "call_1",
      toolName: "bash",
      input: { command: "ls" },
      cwd: "/work",
    };
    expect(parseApprovalRequest(JSON.stringify(request))).toEqual({
      toolCallId: "call_1",
      toolName: "bash",
      input: { command: "ls" },
      cwd: "/work",
    });
    expect(parseApprovalRequest("not json")).toBeUndefined();
    expect(parseApprovalRequest(undefined)).toBeUndefined();
    expect(parseApprovalRequest(JSON.stringify({ title: "Allow?" }))).toBeUndefined();
  });
});

describe("Pi detection", () => {
  it("runs sessions on Pi 1.5.0 or later", () => {
    expect(isSupportedPiVersion("1.5.0")).toBe(true);
    expect(isSupportedPiVersion("1.5.2")).toBe(true);
    expect(isSupportedPiVersion("1.4.9")).toBe(false);
    expect(isSupportedPiVersion(null)).toBe(false);
    expect(piTooOldMessage("1.4.0")).toBe("Pi 1.4.0 is too old (needs 1.5.0+)");
  });

  it("reads the startup model from Pi's own settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-pi-settings-"));
    mkdirSync(dir, { recursive: true });
    expect(readPiDefaultModel(dir)).toBeUndefined();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-20250514" }),
    );
    expect(readPiDefaultModel(dir)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
    writeFileSync(join(dir, "settings.json"), "{ not json");
    expect(readPiDefaultModel(dir)).toBeUndefined();
  });
});

describe("Pi's process environment", () => {
  it("drops CodeDen's variables and a parent Pi's session", () => {
    const env = piEnv({ PI_SESSION_FILE: "/x.jsonl", KEEP: "1" });
    expect(env.KEEP).toBe("1");
    expect(env.PI_SESSION_FILE).toBeUndefined();
  });
});

describe("Pi prompt input", () => {
  const image = (name: string) => ({
    type: "image" as const,
    mediaType: "image/png" as const,
    source: { type: "base64" as const, data: "aGk=" },
    name,
  });

  it("sends images inline to a model that takes them", () => {
    expect(promptFor({ text: "Look", attachments: [image("shot.png")] }, true)).toEqual({
      message: "Look",
      images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    });
  });

  it("names files and images a model can't take, so the agent can read them", () => {
    const prompt = promptFor(
      {
        text: "Look",
        attachments: [image("shot.png"), { type: "file", path: "/work/notes.md" }],
      },
      false,
    );
    expect(prompt.images).toEqual([]);
    expect(prompt.message).toBe("Look\n\nFiles in this message:\n- shot.png\n- /work/notes.md");
  });
});
