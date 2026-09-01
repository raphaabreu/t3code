import { describe, expect, it } from "@effect/vitest";

import { initialWolfScanState, mightCarryUsage, parseWolfLine } from "./usageTranscripts.ts";

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
    const record = parseWolfLine(assistantLine, SESSION, initialWolfScanState());
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
    const record = parseWolfLine(titleLine, SESSION, initialWolfScanState());
    expect(record?.totals.uncachedInputTokens).toBe(8456);
    expect(record?.reportedCostUsd).toBe(0.04258);
  });

  it("attributes a title to the model named by a preceding model_change", () => {
    // Wolf omits the model on title/compaction entries but bills them at the
    // active model's rate, so the scan carries it forward.
    const state = initialWolfScanState();
    expect(
      parseWolfLine(
        JSON.stringify({
          type: "model_change",
          id: "mc",
          timestamp: "2026-08-29T16:17:37.816Z",
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
        }),
        SESSION,
        state,
      ),
    ).toBeNull();
    expect(parseWolfLine(titleLine, SESSION, state)?.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("lets a later assistant message move the active model", () => {
    const state = initialWolfScanState();
    parseWolfLine(assistantLine, SESSION, state);
    expect(parseWolfLine(titleLine, SESSION, state)?.model).toBe("openai-codex/gpt-5.6-sol");

    const switched = JSON.stringify({
      type: "message",
      id: "switched",
      timestamp: "2026-08-29T16:20:00.000Z",
      message: {
        role: "assistant",
        content: [],
        provider: "anthropic",
        model: "claude-sonnet-5",
        usage: { input: 5, output: 1 },
      },
    });
    expect(parseWolfLine(switched, SESSION, state)?.model).toBe("anthropic/claude-sonnet-5");
    expect(parseWolfLine(titleLine, SESSION, state)?.model).toBe("anthropic/claude-sonnet-5");
  });

  it("falls back to unknown when nothing established a model first", () => {
    expect(parseWolfLine(titleLine, SESSION, initialWolfScanState())?.model).toBe("unknown");
  });

  it("does not leak the active model between files", () => {
    // The reader builds fresh state per transcript; sharing it would attribute
    // one session's compaction to another session's model.
    const first = initialWolfScanState();
    parseWolfLine(assistantLine, SESSION, first);
    expect(first.activeModel).toBe("openai-codex/gpt-5.6-sol");
    expect(initialWolfScanState().activeModel).toBeUndefined();
  });

  it("ignores user messages and entries without usage", () => {
    expect(parseWolfLine(userLine, SESSION, initialWolfScanState())).toBeNull();
    expect(
      parseWolfLine(
        JSON.stringify({ type: "thinking_level_change", id: "a" }),
        SESSION,
        initialWolfScanState(),
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
    expect(parseWolfLine(line, SESSION, initialWolfScanState())).toBeNull();
  });

  it("keys dedupe on the entry id so a forked branch is not double-counted", () => {
    // Wolf sessions are append-only trees; a fork copies ancestry by
    // reference, so the same entry id must resolve to one billed call.
    expect(parseWolfLine(assistantLine, SESSION, initialWolfScanState())?.dedupeKey).toBe(
      "wolf:cf0299ac",
    );
    expect(parseWolfLine(assistantLine, "other-session", initialWolfScanState())?.dedupeKey).toBe(
      "wolf:cf0299ac",
    );
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
    expect(parseWolfLine(line, SESSION, initialWolfScanState())?.model).toBe("gpt-5.6-sol");
  });

  it("rejects malformed lines rather than throwing", () => {
    expect(parseWolfLine("not json", SESSION, initialWolfScanState())).toBeNull();
    expect(parseWolfLine("null", SESSION, initialWolfScanState())).toBeNull();
    expect(
      parseWolfLine(
        JSON.stringify({ type: "message", message: { role: "assistant" } }),
        SESSION,
        initialWolfScanState(),
      ),
    ).toBeNull();
  });
});
