import { describe, expect, it } from "@effect/vitest";

import { mightCarryUsage, parseWolfLine } from "./usageTranscripts.ts";

const SESSION = "01a04e4f-f3f3-7f20-bf91-7496695bed4d";

const assistantLine = JSON.stringify({
  type: "message",
  id: "cf0299ac",
  parentId: "fb2139c5",
  timestamp: "2026-08-29T16:18:59.320Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: {
      input: 8456,
      output: 120,
      cacheRead: 40,
      cacheWrite: 10,
      reasoning: 30,
      totalTokens: 8616,
      cost: { input: 0.042, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.045 },
    },
    stopReason: "stop",
  },
});

const titleLine = JSON.stringify({
  type: "session_title",
  id: "fb2139c5",
  timestamp: "2026-08-29T16:18:17.212Z",
  title: "Verify UniFi DNS Query Privacy",
  source: "automatic",
  usage: {
    input: 8456,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 8466,
    cost: { total: 0.04258 },
  },
});

const userLine = JSON.stringify({
  type: "message",
  id: "e048c199",
  timestamp: "2026-08-29T16:18:14.005Z",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});

describe("mightCarryUsage for wolf", () => {
  it("keeps lines carrying usage and skips the rest", () => {
    expect(mightCarryUsage(assistantLine, "wolf")).toBe(true);
    expect(mightCarryUsage(userLine, "wolf")).toBe(false);
  });
});

describe("parseWolfLine", () => {
  it("maps an assistant message onto token totals and provider-reported cost", () => {
    const record = parseWolfLine(assistantLine, SESSION);
    expect(record).not.toBeNull();
    expect(record?.provider).toBe("wolf");
    expect(record?.model).toBe("openai-codex/gpt-5.6-sol");
    expect(record?.sessionId).toBe(SESSION);
    expect(record?.reportedCostUsd).toBe(0.045);
    expect(record?.totals).toEqual({
      uncachedInputTokens: 8456,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 120,
      reasoningTokens: 30,
    });
    expect(record?.timestampMs).toBe(Date.parse("2026-08-29T16:18:59.320Z"));
  });

  it("counts model calls wolf makes on its own behalf", () => {
    const record = parseWolfLine(titleLine, SESSION);
    expect(record?.totals.uncachedInputTokens).toBe(8456);
    expect(record?.reportedCostUsd).toBe(0.04258);
  });

  it("ignores user messages and entries without usage", () => {
    expect(parseWolfLine(userLine, SESSION)).toBeNull();
    expect(
      parseWolfLine(
        JSON.stringify({ type: "model_change", id: "a", timestamp: "2026-08-29T16:17:37.816Z" }),
        SESSION,
      ),
    ).toBeNull();
  });

  it("ignores an assistant message whose usage is all zero", () => {
    const line = JSON.stringify({
      type: "message",
      id: "zero",
      timestamp: "2026-08-29T16:18:59.320Z",
      message: {
        role: "assistant",
        content: [],
        model: "gpt-5.6-sol",
        provider: "openai-codex",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    });
    expect(parseWolfLine(line, SESSION)).toBeNull();
  });

  it("keys dedupe on the entry id so a forked branch is not double-counted", () => {
    // Wolf sessions are append-only trees; a fork copies ancestry by
    // reference, so the same entry id must resolve to one billed call.
    expect(parseWolfLine(assistantLine, SESSION)?.dedupeKey).toBe("wolf:cf0299ac");
    expect(parseWolfLine(assistantLine, "other-session")?.dedupeKey).toBe("wolf:cf0299ac");
  });

  it("falls back to the bare model id when no provider is recorded", () => {
    const line = JSON.stringify({
      type: "message",
      id: "np",
      timestamp: "2026-08-29T16:18:59.320Z",
      message: {
        role: "assistant",
        content: [],
        model: "gpt-5.6-sol",
        usage: { input: 10, output: 1 },
      },
    });
    expect(parseWolfLine(line, SESSION)?.model).toBe("gpt-5.6-sol");
  });

  it("rejects malformed lines rather than throwing", () => {
    expect(parseWolfLine("not json", SESSION)).toBeNull();
    expect(parseWolfLine("null", SESSION)).toBeNull();
    expect(
      parseWolfLine(JSON.stringify({ type: "message", message: { role: "assistant" } }), SESSION),
    ).toBeNull();
  });
});
