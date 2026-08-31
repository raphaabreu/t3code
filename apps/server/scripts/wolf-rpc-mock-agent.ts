#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Deterministic stand-in for `wolf --mode rpc`.
 *
 * Replays the event shapes captured from a real Wolf process so adapter tests
 * exercise the true protocol without a model call. Behaviour is selected with
 * `T3_WOLF_MOCK_*` environment variables.
 */
import * as NodeProcess from "node:process";

const emitToolCall = NodeProcess.env.T3_WOLF_MOCK_EMIT_TOOL_CALL === "1";
const failTurn = NodeProcess.env.T3_WOLF_MOCK_FAIL_TURN === "1";
const hangTurn = NodeProcess.env.T3_WOLF_MOCK_HANG_TURN === "1";
const exitOnPrompt = NodeProcess.env.T3_WOLF_MOCK_EXIT_ON_PROMPT === "1";
const emitLeadingNoise = NodeProcess.env.T3_WOLF_MOCK_EMIT_LEADING_NOISE === "1";
const replyText = NodeProcess.env.T3_WOLF_MOCK_REPLY_TEXT ?? "Mock wolf reply.";
const modelId = NodeProcess.env.T3_WOLF_MOCK_MODEL ?? "gpt-5.6-sol";

function send(payload: unknown): void {
  NodeProcess.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id: string | undefined, command: string, data?: unknown): void {
  if (id === undefined) return;
  send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

let steerCount = 0;

function runTurn(): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });

  if (emitToolCall) {
    const toolCallId = "call_mock|fc_mock";
    send({
      type: "tool_execution_start",
      toolCallId,
      toolName: "bash",
      args: { command: "echo hi" },
    });
    send({
      type: "tool_execution_update",
      toolCallId,
      toolName: "bash",
      args: { command: "echo hi" },
      partialResult: { content: [{ type: "text", text: "hi\n" }] },
    });
    send({
      type: "tool_execution_end",
      toolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "hi\n" }] },
      isError: false,
    });
  }

  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  for (const chunk of replyText.split(" ")) {
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${chunk} ` },
    });
  }
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: replyText },
  });

  send({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      model: modelId,
      provider: "openai-codex",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        reasoning: 2,
        totalTokens: 125,
        cost: { total: 0.5 },
      },
      stopReason: failTurn ? "error" : "stop",
      ...(failTurn ? { errorMessage: "Mock wolf failure." } : {}),
    },
    toolResults: [],
  });
  send({ type: "agent_end", messages: [], willRetry: false });
  send({ type: "agent_settled" });
}

let buffer = "";
NodeProcess.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index === -1) break;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let command: Record<string, unknown>;
    try {
      command = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof command.id === "string" ? command.id : undefined;
    switch (command.type) {
      case "prompt":
        if (exitOnPrompt) {
          NodeProcess.exit(1);
        }
        respond(id, "prompt");
        if (!hangTurn) runTurn();
        break;
      case "steer":
        steerCount += 1;
        respond(id, "steer");
        break;
      case "abort":
        respond(id, "abort");
        send({ type: "agent_settled" });
        break;
      case "set_model":
        respond(id, "set_model", { id: modelId });
        break;
      case "get_available_models":
        respond(id, "get_available_models", {
          models: [
            { id: modelId, name: "GPT-5.6 Sol", provider: "openai-codex" },
            { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
          ],
        });
        break;
      case "get_state":
        respond(id, "get_state", { model: { id: modelId }, isStreaming: false, steerCount });
        break;
      default:
        respond(id, String(command.type ?? "unknown"));
        break;
    }
  }
});

// A real Wolf emits extension status events before any command arrives; the
// client must tolerate them.
if (emitLeadingNoise) {
  send({ type: "extension_ui_request", id: "noise-1", method: "setStatus", statusKey: "mock" });
  NodeProcess.stdout.write("not json at all\n");
}
