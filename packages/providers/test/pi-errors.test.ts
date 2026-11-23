import { describe, expect, it } from "vitest";
import { classifyPiError, piErrorInfo } from "../src/pi/errors";

describe("Pi error classification", () => {
  it("reads a full context window in the provider's own words", () => {
    // Anthropic, OpenAI, Google and a LiteLLM-style proxy, as Pi passes them through.
    expect(classifyPiError("prompt is too long: 213462 tokens > 200000 maximum")).toBe(
      "context_full",
    );
    expect(classifyPiError("Your input exceeds the context window of this model")).toBe(
      "context_full",
    );
    expect(classifyPiError("The input token count (1196265) exceeds the maximum")).toBe(
      "context_full",
    );
    expect(classifyPiError("litellm.ContextWindowExceededError: Context Window exceeded")).toBe(
      "context_full",
    );
  });

  it("reads a sign-in problem apart from a spent allowance", () => {
    expect(classifyPiError("No API key for anthropic/claude-sonnet-4")).toBe("auth");
    expect(classifyPiError("401 Unauthorized: invalid api key")).toBe("auth");
    expect(classifyPiError("You have hit your usage limit; resets in 3 hours")).toBe("usage_limit");
    expect(classifyPiError("429 rate limit reached; retry in 5s")).toBe("usage_limit");
  });

  it("keeps overload and dropped streams retryable, and anything else fatal", () => {
    expect(classifyPiError("503 Service Unavailable: overloaded")).toBe("transient");
    expect(classifyPiError("stream ended without a finish reason")).toBe("transient");
    expect(classifyPiError("the tool arguments were invalid")).toBe("fatal");
  });

  it("says whether another turn may help", () => {
    expect(piErrorInfo("overloaded")).toMatchObject({ code: "turn_failed", retryable: true });
    expect(piErrorInfo("bad request", "prompt_failed")).toMatchObject({
      code: "prompt_failed",
      kind: "fatal",
      retryable: false,
    });
  });
});
