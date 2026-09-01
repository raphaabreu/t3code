/**
 * Wire types and pure parsers for the `wolf --mode rpc` JSONL protocol.
 *
 * Wolf frames records with LF only. Generic line readers are not
 * protocol-compliant here: Node's `readline` also splits on U+2028/U+2029,
 * which are legal inside JSON strings.
 *
 * @module provider/wolf/WolfRpcProtocol
 */

/** Assistant streaming delta kinds carried by `message_update`. */
export type WolfAssistantDeltaType =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "toolcall_start"
  | "toolcall_delta"
  | "toolcall_end"
  | "done"
  | "error";

export interface WolfUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly totalTokens?: number;
  readonly cost?: { readonly total?: number };
}

export interface WolfToolCall {
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

export interface WolfContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
}

export interface WolfMessage {
  readonly role?: string;
  readonly content?: string | ReadonlyArray<WolfContentBlock>;
  readonly model?: string;
  readonly provider?: string;
  readonly usage?: WolfUsage;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

/** A decoded stdout record: either a command response or an agent event. */
export type WolfRpcRecord =
  | {
      readonly kind: "response";
      readonly id?: string;
      readonly command?: string;
      readonly success: boolean;
      readonly error?: string;
      readonly data?: unknown;
    }
  | { readonly kind: "event"; readonly type: string; readonly payload: Record<string, unknown> }
  | { readonly kind: "unknown"; readonly payload: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeWolfRecord(line: string): WolfRpcRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { kind: "unknown", payload: parsed };
  }
  if (parsed.type === "response") {
    return {
      kind: "response",
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      ...(typeof parsed.command === "string" ? { command: parsed.command } : {}),
      success: parsed.success === true,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      data: parsed.data,
    };
  }
  return { kind: "event", type: parsed.type, payload: parsed };
}

/**
 * Splits a rolling buffer into complete LF-delimited records, returning the
 * unconsumed remainder. A trailing CR is stripped so CRLF input still decodes.
 */
export function splitJsonLines(buffer: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const lines: Array<string> = [];
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf("\n");
    if (index === -1) break;
    const line = rest.slice(0, index);
    rest = rest.slice(index + 1);
    lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
  return { lines, rest };
}

export function messageText(message: WolfMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

export function toolCallsOf(message: WolfMessage | undefined): ReadonlyArray<WolfToolCall> {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is WolfContentBlock & WolfToolCall => block?.type === "toolCall",
  );
}

/**
 * Wolf reports a failed turn as a normal `turn_end` whose assistant message
 * carries `stopReason: "error"`, so callers must inspect the message rather
 * than wait for a transport failure.
 */
export function turnErrorMessage(message: WolfMessage | undefined): string | undefined {
  if (message?.stopReason !== "error") return undefined;
  const detail = message.errorMessage?.trim();
  return detail && detail.length > 0 ? detail : "Wolf turn failed.";
}

export function normalizeUsage(usage: WolfUsage | undefined): {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalCost: number;
} {
  return {
    inputTokens: Math.max(0, Math.trunc(usage?.input ?? 0)),
    cachedInputTokens: Math.max(0, Math.trunc(usage?.cacheRead ?? 0)),
    cacheCreationTokens: Math.max(0, Math.trunc(usage?.cacheWrite ?? 0)),
    outputTokens: Math.max(0, Math.trunc(usage?.output ?? 0)),
    reasoningTokens: Math.max(0, Math.trunc(usage?.reasoning ?? 0)),
    totalCost: Math.max(0, usage?.cost?.total ?? 0),
  };
}
