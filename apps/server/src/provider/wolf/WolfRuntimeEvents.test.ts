import { describe, expect, it } from "@effect/vitest";
import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";

import {
  canonicalItemTypeForTool,
  isSettleEvent,
  readTurnEnd,
  translateWolfEvent,
  type WolfEventContext,
} from "./WolfRuntimeEvents.ts";

const context: WolfEventContext = {
  stamp: { eventId: EventId.make("event-1"), createdAt: "2026-01-01T00:00:00.000Z" },
  provider: ProviderDriverKind.make("wolf"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
};

const translate = (type: string, payload: Record<string, unknown>) =>
  translateWolfEvent({ context, event: { type, payload }, assistantItemId: "assistant-1" });

describe("canonicalItemTypeForTool", () => {
  it("classifies wolf's built-in tools", () => {
    expect(canonicalItemTypeForTool("bash")).toBe("command_execution");
    expect(canonicalItemTypeForTool("edit")).toBe("file_change");
    expect(canonicalItemTypeForTool("write")).toBe("file_change");
    expect(canonicalItemTypeForTool("webfetch")).toBe("web_search");
  });

  it("routes MCP tools to the MCP item type", () => {
    expect(canonicalItemTypeForTool("mcp__linear__list_issues")).toBe("mcp_tool_call");
  });

  it("falls back to a dynamic tool call for extension tools", () => {
    expect(canonicalItemTypeForTool("my_custom_tool")).toBe("dynamic_tool_call");
  });
});

describe("translateWolfEvent", () => {
  it("maps a text delta to an assistant content delta", () => {
    const events = translate("message_update", {
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "content.delta",
      itemId: "assistant-1",
      turnId: "turn-1",
      payload: { streamKind: "assistant_text", delta: "Hello" },
    });
  });

  it("maps a thinking delta to reasoning text", () => {
    const events = translate("message_update", {
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });
    expect(events[0]).toMatchObject({ payload: { streamKind: "reasoning_text", delta: "hmm" } });
  });

  it("brackets streamed assistant text with item lifecycle events", () => {
    expect(
      translate("message_update", { assistantMessageEvent: { type: "text_start" } })[0],
    ).toMatchObject({ type: "item.started", payload: { itemType: "assistant_message" } });
    expect(
      translate("message_update", {
        assistantMessageEvent: { type: "text_end", content: "done" },
      })[0],
    ).toMatchObject({
      type: "item.completed",
      payload: { itemType: "assistant_message", status: "completed", detail: "done" },
    });
  });

  it("ignores deltas that carry no text", () => {
    expect(translate("message_update", { assistantMessageEvent: { type: "text_delta" } })).toEqual(
      [],
    );
    expect(translate("message_update", {})).toEqual([]);
  });

  it("maps the tool execution lifecycle onto item events", () => {
    const started = translate("tool_execution_start", {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(started[0]).toMatchObject({
      type: "item.started",
      itemId: "call-1",
      payload: { itemType: "command_execution", status: "inProgress", title: "bash" },
    });

    const updated = translate("tool_execution_update", {
      toolCallId: "call-1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    expect(updated[0]).toMatchObject({
      type: "item.updated",
      payload: { status: "inProgress", detail: "partial" },
    });

    const completed = translate("tool_execution_end", {
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "output" }] },
      isError: false,
    });
    expect(completed[0]).toMatchObject({
      type: "item.completed",
      payload: { status: "completed", detail: "output" },
    });
  });

  it("marks a failed tool call as failed", () => {
    const events = translate("tool_execution_end", {
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "boom" }] },
      isError: true,
    });
    expect(events[0]).toMatchObject({ payload: { status: "failed" } });
  });

  it("surfaces auto-retry and extension failures as runtime warnings", () => {
    expect(translate("auto_retry_start", { errorMessage: "529 overloaded" })[0]).toMatchObject({
      type: "runtime.warning",
      payload: { message: "Wolf is retrying after a transient error: 529 overloaded" },
    });
    expect(translate("extension_error", { error: "bad ext" })[0]).toMatchObject({
      type: "runtime.warning",
    });
  });

  it("drops events the runtime has no representation for", () => {
    expect(translate("queue_update", { steering: [] })).toEqual([]);
    expect(translate("agent_start", {})).toEqual([]);
  });
});

describe("isSettleEvent", () => {
  it("treats only agent_settled as the settle signal", () => {
    // agent_end still precedes retries and queued continuations.
    expect(isSettleEvent("agent_end")).toBe(false);
    expect(isSettleEvent("agent_settled")).toBe(true);
  });
});

describe("readTurnEnd", () => {
  it("reads usage, model, and text from a successful turn", () => {
    const outcome = readTurnEnd({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        model: "gpt-5.6-sol",
        usage: { input: 10, output: 3, cacheRead: 1, cost: { total: 0.02 } },
        stopReason: "stop",
      },
    });
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.model).toBe("gpt-5.6-sol");
    expect(outcome.assistantText).toBe("answer");
    expect(outcome.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, totalCost: 0.02 });
  });

  it("reports a provider failure carried by a normal turn_end", () => {
    const outcome = readTurnEnd({
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "OAuth refresh failed for anthropic",
      },
    });
    expect(outcome.errorMessage).toBe("OAuth refresh failed for anthropic");
  });
});
