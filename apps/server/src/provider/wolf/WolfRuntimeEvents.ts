/**
 * Pure translation from Wolf RPC events to canonical runtime events.
 *
 * Kept free of Effect so the mapping can be tested directly against
 * transcripts captured from a real `wolf --mode rpc` process.
 *
 * @module provider/wolf/WolfRuntimeEvents
 */
import {
  type CanonicalItemType,
  type EventId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import {
  messageText,
  normalizeUsage,
  type WolfMessage,
  type WolfUsage,
} from "./WolfRpcProtocol.ts";

export interface WolfEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface WolfEventContext {
  readonly stamp: WolfEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
}

/**
 * Wolf tool names are free-form (built-in, extension, and MCP tools all share
 * the namespace), so the canonical item type is inferred from the name.
 */
export function canonicalItemTypeForTool(toolName: string): ToolLifecycleItemType {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "shell" || name.startsWith("bash_")) return "command_execution";
  if (name === "edit" || name === "write" || name === "multiedit" || name === "apply_patch") {
    return "file_change";
  }
  if (name === "websearch" || name === "web_search" || name === "webfetch") return "web_search";
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function streamKindForDelta(deltaType: string): RuntimeContentStreamKind | undefined {
  if (deltaType === "text_delta") return "assistant_text";
  if (deltaType === "thinking_delta") return "reasoning_text";
  return undefined;
}

function textFromToolResultContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

/** Tool output can be large; runtime item detail is a preview, not a payload. */
const TOOL_DETAIL_MAX_CHARS = 2000;

function truncate(value: string): string {
  return value.length > TOOL_DETAIL_MAX_CHARS ? `${value.slice(0, TOOL_DETAIL_MAX_CHARS)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolLifecycleEvent(input: {
  readonly context: WolfEventContext;
  readonly lifecycle: "item.started" | "item.updated" | "item.completed";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly detail: string | undefined;
  readonly failed: boolean;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const status =
    input.lifecycle === "item.completed" ? (input.failed ? "failed" : "completed") : "inProgress";
  return {
    type: input.lifecycle,
    ...input.context.stamp,
    provider: input.context.provider,
    threadId: input.context.threadId,
    turnId: input.context.turnId,
    itemId: RuntimeItemId.make(input.toolCallId),
    payload: {
      itemType: canonicalItemTypeForTool(input.toolName) satisfies CanonicalItemType,
      status,
      title: input.toolName,
      ...(input.detail ? { detail: truncate(input.detail) } : {}),
      ...(input.args === undefined ? {} : { data: { args: input.args } }),
    },
    raw: { source: "wolf.rpc.event", method: input.lifecycle, payload: input.rawPayload },
  };
}

/**
 * Maps one Wolf event to zero or more runtime events.
 *
 * Turn lifecycle (`turn.started` / `turn.completed`) is owned by the adapter,
 * which knows whether a prompt is a new turn or a steer, so it is not derived
 * here. `agent_settled` is reported through {@link isSettleEvent} instead.
 */
export function translateWolfEvent(input: {
  readonly context: WolfEventContext;
  readonly event: { readonly type: string; readonly payload: Record<string, unknown> };
  readonly assistantItemId: string;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const { context, event } = input;
  const base = {
    ...context.stamp,
    provider: context.provider,
    threadId: context.threadId,
    turnId: context.turnId,
  } as const;

  switch (event.type) {
    case "message_update": {
      const delta = event.payload.assistantMessageEvent;
      if (!isRecord(delta) || typeof delta.type !== "string") return [];
      const streamKind = streamKindForDelta(delta.type);
      if (streamKind && typeof delta.delta === "string" && delta.delta.length > 0) {
        return [
          {
            type: "content.delta",
            ...base,
            itemId: RuntimeItemId.make(input.assistantItemId),
            payload: { streamKind, delta: delta.delta },
            raw: {
              source: "wolf.rpc.event",
              method: "message_update",
              payload: event.payload,
            },
          },
        ];
      }
      if (delta.type === "text_start") {
        return [
          {
            type: "item.started",
            ...base,
            itemId: RuntimeItemId.make(input.assistantItemId),
            payload: { itemType: "assistant_message", status: "inProgress" },
          },
        ];
      }
      if (delta.type === "text_end") {
        return [
          {
            type: "item.completed",
            ...base,
            itemId: RuntimeItemId.make(input.assistantItemId),
            payload: {
              itemType: "assistant_message",
              status: "completed",
              ...(typeof delta.content === "string" && delta.content.trim()
                ? { detail: truncate(delta.content) }
                : {}),
            },
          },
        ];
      }
      return [];
    }

    case "tool_execution_start": {
      const toolCallId = event.payload.toolCallId;
      const toolName = event.payload.toolName;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return [];
      return [
        toolLifecycleEvent({
          context,
          lifecycle: "item.started",
          toolCallId,
          toolName,
          args: event.payload.args,
          detail: undefined,
          failed: false,
          rawPayload: event.payload,
        }),
      ];
    }

    case "tool_execution_update": {
      const toolCallId = event.payload.toolCallId;
      const toolName = event.payload.toolName;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return [];
      const partial = event.payload.partialResult;
      return [
        toolLifecycleEvent({
          context,
          lifecycle: "item.updated",
          toolCallId,
          toolName,
          args: event.payload.args,
          detail: isRecord(partial) ? textFromToolResultContent(partial.content) : undefined,
          failed: false,
          rawPayload: event.payload,
        }),
      ];
    }

    case "tool_execution_end": {
      const toolCallId = event.payload.toolCallId;
      const toolName = event.payload.toolName;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return [];
      const result = event.payload.result;
      return [
        toolLifecycleEvent({
          context,
          lifecycle: "item.completed",
          toolCallId,
          toolName,
          args: event.payload.args,
          detail: isRecord(result) ? textFromToolResultContent(result.content) : undefined,
          failed: event.payload.isError === true,
          rawPayload: event.payload,
        }),
      ];
    }

    case "auto_retry_start": {
      const errorMessage = event.payload.errorMessage;
      return [
        {
          type: "runtime.warning",
          ...base,
          payload: {
            message: `Wolf is retrying after a transient error${
              typeof errorMessage === "string" && errorMessage.trim()
                ? `: ${truncate(errorMessage)}`
                : "."
            }`,
          },
          raw: {
            source: "wolf.rpc.event",
            method: "auto_retry_start",
            payload: event.payload,
          },
        },
      ];
    }

    case "extension_error": {
      const detail = event.payload.error;
      return [
        {
          type: "runtime.warning",
          ...base,
          payload: {
            message: `Wolf extension error${
              typeof detail === "string" && detail.trim() ? `: ${truncate(detail)}` : "."
            }`,
          },
          raw: {
            source: "wolf.rpc.event",
            method: "extension_error",
            payload: event.payload,
          },
        },
      ];
    }

    default:
      return [];
  }
}

/** `agent_settled` is the only signal that no retry or queued work remains. */
export function isSettleEvent(eventType: string): boolean {
  return eventType === "agent_settled";
}

export interface WolfTurnOutcome {
  readonly usage: ReturnType<typeof normalizeUsage>;
  readonly model: string | undefined;
  readonly errorMessage: string | undefined;
  readonly assistantText: string;
}

/** Reads the assistant message a `turn_end` event carries. */
export function readTurnEnd(payload: Record<string, unknown>): WolfTurnOutcome {
  const message = (isRecord(payload.message) ? payload.message : undefined) as
    | WolfMessage
    | undefined;
  const rawError = message?.stopReason === "error" ? message.errorMessage?.trim() : undefined;
  return {
    usage: normalizeUsage(message?.usage as WolfUsage | undefined),
    model: typeof message?.model === "string" ? message.model : undefined,
    errorMessage: message?.stopReason === "error" ? rawError || "Wolf turn failed." : undefined,
    assistantText: messageText(message),
  };
}
