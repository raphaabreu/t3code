import { describe, expect, it } from "@effect/vitest";

import {
  decodeWolfRecord,
  messageText,
  normalizeUsage,
  splitJsonLines,
  turnErrorMessage,
} from "./WolfRpcProtocol.ts";

describe("splitJsonLines", () => {
  it("splits on LF only and keeps the trailing partial record", () => {
    const result = splitJsonLines('{"a":1}\n{"b":2}\n{"c":');
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.rest).toBe('{"c":');
  });

  it("strips a trailing CR so CRLF input still decodes", () => {
    expect(splitJsonLines('{"a":1}\r\n').lines).toEqual(['{"a":1}']);
  });

  it("keeps U+2028 inside a record instead of treating it as a delimiter", () => {
    // Node's readline splits on U+2028/U+2029, which are legal inside JSON
    // strings; only LF may end a record.
    const line = JSON.stringify({ type: "agent_start", text: "a\u2028b" });
    const result = splitJsonLines(`${line}\n`);
    expect(result.lines).toEqual([line]);
    expect(decodeWolfRecord(result.lines[0]!)).toMatchObject({
      kind: "event",
      type: "agent_start",
    });
  });
});

describe("decodeWolfRecord", () => {
  it("decodes a command response", () => {
    expect(
      decodeWolfRecord('{"id":"1","type":"response","command":"prompt","success":true}'),
    ).toEqual({ kind: "response", id: "1", command: "prompt", success: true, data: undefined });
  });

  it("decodes a failed response with its error", () => {
    const record = decodeWolfRecord(
      '{"id":"1","type":"response","command":"set_model","success":false,"error":"nope"}',
    );
    expect(record).toMatchObject({ kind: "response", success: false, error: "nope" });
  });

  it("decodes an agent event", () => {
    expect(decodeWolfRecord('{"type":"agent_settled"}')).toEqual({
      kind: "event",
      type: "agent_settled",
      payload: { type: "agent_settled" },
    });
  });

  it("ignores blank lines and non-JSON noise", () => {
    expect(decodeWolfRecord("   ")).toBeUndefined();
    expect(decodeWolfRecord("not json")).toBeUndefined();
  });
});

describe("messageText", () => {
  it("concatenates text blocks and ignores other content", () => {
    expect(
      messageText({
        content: [
          { type: "text", text: "a" },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });

  it("accepts plain string content", () => {
    expect(messageText({ content: "hello" })).toBe("hello");
  });
});

describe("turnErrorMessage", () => {
  it("reports the provider error for a failed turn", () => {
    expect(
      turnErrorMessage({ stopReason: "error", errorMessage: "OAuth refresh failed for anthropic" }),
    ).toBe("OAuth refresh failed for anthropic");
  });

  it("falls back to a generic message when the detail is blank", () => {
    expect(turnErrorMessage({ stopReason: "error", errorMessage: "  " })).toBe("Wolf turn failed.");
  });

  it("returns nothing for a successful turn", () => {
    expect(turnErrorMessage({ stopReason: "stop" })).toBeUndefined();
  });
});

describe("normalizeUsage", () => {
  it("maps wolf usage fields onto the reporting shape", () => {
    expect(
      normalizeUsage({
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 3,
        reasoning: 2,
        cost: { total: 0.25 },
      }),
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 5,
      cacheCreationTokens: 3,
      outputTokens: 20,
      reasoningTokens: 2,
      totalCost: 0.25,
    });
  });

  it("treats missing usage as zero rather than NaN", () => {
    expect(normalizeUsage(undefined)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalCost: 0,
    });
  });
});
