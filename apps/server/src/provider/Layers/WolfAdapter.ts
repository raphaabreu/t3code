/**
 * WolfAdapter — Wolf CLI (`wolf --mode rpc`) over its native JSONL protocol.
 *
 * One child process per thread. T3 threads map onto Wolf sessions through
 * `--session-id`, which creates the session on first use and resumes it
 * afterwards, so a restarted server rejoins the same conversation.
 *
 * @module WolfAdapter
 */
import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
  type WolfSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { WolfAdapterShape } from "../Services/WolfAdapter.ts";
import { makeWolfRpcClient, type WolfRpcClient } from "../wolf/WolfRpcClient.ts";
import { resolveWolfBinary, wolfSessionIdForThread } from "../wolf/WolfCli.ts";
import {
  isSettleEvent,
  readTurnEnd,
  translateWolfEvent,
  type WolfEventContext,
} from "../wolf/WolfRuntimeEvents.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("wolf");
const WOLF_RESUME_VERSION = 1 as const;

export interface WolfAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  readonly instanceId?: ProviderInstanceId | undefined;
}

interface WolfSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly client: WolfRpcClient;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /** Assistant item id for the current turn's streamed text. */
  assistantItemId: string;
  /** Resolved by the event pump when Wolf reports `agent_settled`. */
  settle: Deferred.Deferred<void> | undefined;
  /** Last `turn_end` seen for the active turn, used to settle the turn. */
  lastTurnEnd: ReturnType<typeof readTurnEnd> | undefined;
  /** Set when the child died mid-turn, so the turn reports failure not success. */
  exitedUnexpectedly: boolean;
  /** >0 means a prompt is running, so a new sendTurn steers the active turn. */
  promptsInFlight: number;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWolfResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== WOLF_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/**
 * Wolf accepts `--model provider/id`; `set_model` needs the halves apart.
 */
export function splitWolfModel(
  model: string | undefined,
): { provider: string; modelId: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return {
    provider: model.slice(0, separator),
    modelId: model.slice(separator + 1),
  };
}

/**
 * Wolf runs its tools without a permission system, so every runtime mode
 * behaves as full access. The mismatch is surfaced once per session rather
 * than silently downgraded.
 */
export function runtimeModeWarning(runtimeMode: RuntimeMode): string | undefined {
  return runtimeMode === "approval-required" || runtimeMode === "auto-accept-edits"
    ? "Wolf has no permission system: tools run without approval prompts regardless of the selected mode."
    : undefined;
}

export function makeWolfAdapter(wolfSettings: WolfSettings, options?: WolfAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("wolf");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger = options?.nativeEventLogger;

    const sessions = new Map<ThreadId, WolfSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a Wolf runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({
        eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
        createdAt: nowIso,
      });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, {
        ...event,
        providerInstanceId: boundInstanceId,
      }).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        return ctx && !ctx.stopped
          ? Effect.succeed(ctx)
          : Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              }),
            );
      });

    const logNative = (threadId: ThreadId, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger
          .write({ observedAt, provider: PROVIDER, payload }, threadId)
          .pipe(Effect.ignore);
      });

    /**
     * Releases a session whose process is gone. Wolf acknowledges `prompt`
     * before running the turn, so a crash in that window would otherwise leave
     * `sendTurn` waiting on a settle that can never arrive, and leave the dead
     * session registered so recovery never runs.
     */
    const handleSessionEnded = (ctx: WolfSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        ctx.exitedUnexpectedly = true;
        sessions.delete(ctx.threadId);
        if (ctx.settle) yield* Deferred.succeed(ctx.settle, undefined).pipe(Effect.ignore);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "error", reason: "Wolf process exited unexpectedly." },
        });
      });

    const startSession: WolfAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) return existing.session;

          const cwd = input.cwd ?? serverConfig.cwd;
          const resume = parseWolfResume(input.resumeCursor);
          const sessionId = resume?.sessionId ?? wolfSessionIdForThread(input.threadId);
          // Honor a selection only when it targets this instance, matching
          // sendTurn; a foreign slug would be passed as --model and then block
          // the later set_model correction.
          const model =
            input.modelSelection?.instanceId === boundInstanceId
              ? input.modelSelection.model
              : undefined;

          const sessionScope = yield* Scope.make();

          return yield* Effect.gen(function* () {
            const args = [
              "--mode",
              "rpc",
              "--session-id",
              sessionId,
              ...(model ? ["--model", model] : []),
            ];

            const client = yield* makeWolfRpcClient({
              command: resolveWolfBinary(wolfSettings),
              args,
              cwd,
              ...(options?.environment ? { env: options.environment } : {}),
              threadId: input.threadId,
              onRecord: (record) => logNative(input.threadId, record),
            }).pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Crypto.Crypto, crypto),
            );

            const now = yield* nowIso;
            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd,
              ...(model ? { model } : {}),
              threadId: input.threadId,
              resumeCursor: { schemaVersion: WOLF_RESUME_VERSION, sessionId },
              createdAt: now,
              updatedAt: now,
            };

            const ctx: WolfSessionContext = {
              threadId: input.threadId,
              session,
              scope: sessionScope,
              client,
              turns: [],
              activeTurnId: undefined,
              assistantItemId: yield* randomUUIDv4,
              settle: undefined,
              lastTurnEnd: undefined,
              exitedUnexpectedly: false,
              promptsInFlight: 0,
              stopped: false,
            };

            yield* Stream.runForEach(client.events, (event) =>
              Effect.gen(function* () {
                if (event.type === "turn_end") {
                  ctx.lastTurnEnd = readTurnEnd(event.payload);
                  const usage = ctx.lastTurnEnd.usage;
                  yield* offerRuntimeEvent({
                    type: "thread.token-usage.updated",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    payload: {
                      usage: {
                        usedTokens:
                          usage.inputTokens + usage.cachedInputTokens + usage.outputTokens,
                        inputTokens: usage.inputTokens,
                        cachedInputTokens: usage.cachedInputTokens,
                        outputTokens: usage.outputTokens,
                        reasoningOutputTokens: usage.reasoningTokens,
                      },
                    },
                  });
                  return;
                }
                if (isSettleEvent(event.type)) {
                  if (ctx.settle) yield* Deferred.succeed(ctx.settle, undefined);
                  return;
                }
                const context: WolfEventContext = {
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                };
                const translated = translateWolfEvent({
                  context,
                  event,
                  assistantItemId: ctx.assistantItemId,
                });
                yield* Effect.forEach(translated, offerRuntimeEvent, { discard: true });
              }),
            ).pipe(
              Effect.catch((cause) =>
                Effect.logError("Failed to process a Wolf runtime event.", { cause }),
              ),
              // The event stream ends only after stdout has drained and every
              // record has been handled, so this runs strictly after any final
              // `turn_end` / `agent_settled`. Watching the process exit event
              // instead would race the pump and report a finished turn as
              // failed.
              Effect.ensuring(handleSessionEnded(ctx).pipe(Effect.ignore)),
              Effect.forkIn(sessionScope),
            );

            sessions.set(input.threadId, ctx);

            yield* offerRuntimeEvent({
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { message: `Wolf session ${sessionId} ready` },
            });
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Wolf RPC session ready" },
            });
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: sessionId },
            });

            const warning = runtimeModeWarning(input.runtimeMode);
            if (warning) {
              yield* offerRuntimeEvent({
                type: "config.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { summary: warning },
              });
            }

            return session;
          }).pipe(
            // Anything that fails or is interrupted after the spawn must close
            // the scope and drop the registration, or the wolf child outlives
            // the failed startSession and a dead session stays routable.
            Effect.onError(() =>
              Effect.sync(() => {
                const registered = sessions.get(input.threadId);
                if (registered) {
                  registered.stopped = true;
                  sessions.delete(input.threadId);
                }
              }).pipe(Effect.andThen(Scope.close(sessionScope, Exit.void).pipe(Effect.ignore))),
            ),
          );
        }),
      );

    const applyModelSelection = (ctx: WolfSessionContext, model: string | undefined) =>
      Effect.gen(function* () {
        if (!model || model === ctx.session.model) return;
        const split = splitWolfModel(model);
        if (!split) return;
        yield* ctx.client
          .request("set_model", { provider: split.provider, modelId: split.modelId })
          .pipe(Effect.ignore);
        ctx.session = { ...ctx.session, model };
      });

    const sendTurn: WolfAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const text = input.input?.trim();
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text.",
          });
        }

        // A prompt arriving while one is in flight steers the running turn
        // rather than opening a new one.
        const steering = ctx.promptsInFlight > 0;
        const turnId =
          (steering ? ctx.activeTurnId : undefined) ?? TurnId.make(yield* randomUUIDv4);
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          yield* applyModelSelection(ctx, turnModelSelection?.model);

          ctx.activeTurnId = turnId;
          ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };

          if (!steering) {
            ctx.assistantItemId = yield* randomUUIDv4;
            ctx.lastTurnEnd = undefined;
            ctx.settle = yield* Deferred.make<void>();
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              ...(ctx.session.model ? { payload: { model: ctx.session.model } } : { payload: {} }),
            });
          }

          // Always `prompt` with a steering behavior. Wolf consults
          // `streamingBehavior` only when it is already streaming and ignores
          // it when idle, so this is correct in both states — whereas choosing
          // the command from our own in-flight count relies on that count
          // agreeing with Wolf's actual state, and it does not after an
          // interrupt: Wolf is still winding down and rejects a bare prompt
          // with "Agent is already processing". `prompt` also accepts
          // extension and slash commands, which the `steer` command refuses.
          yield* ctx.client.request("prompt", { message: text, streamingBehavior: "steer" });

          const settle = ctx.settle;
          if (settle) yield* Deferred.await(settle);

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: text });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: text }] });
          }

          // Only the last prompt of a steered turn settles it.
          if (ctx.promptsInFlight === 1) {
            const outcome = ctx.lastTurnEnd;
            // A real provider error reported in `turn_end` (rate limit, auth)
            // is more useful than the generic exit text, so it wins.
            const errorMessage =
              outcome?.errorMessage ??
              (ctx.exitedUnexpectedly ? "Wolf exited before finishing the turn." : undefined);
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: errorMessage ? "failed" : "completed",
                ...(errorMessage ? { errorMessage } : {}),
                ...(outcome ? { totalCostUsd: outcome.usage.totalCost } : {}),
              },
            });
            if (errorMessage) {
              yield* offerRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { message: errorMessage, class: "provider_error" },
              });
            }
            ctx.activeTurnId = undefined;
            ctx.settle = undefined;
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: WolfAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* ctx.client.notify("abort").pipe(Effect.ignore);
        // Wolf answers an abort with `agent_settled`, but a process that died
        // mid-turn never will; release the waiter either way.
        if (ctx.settle) yield* Deferred.succeed(ctx.settle, undefined).pipe(Effect.ignore);
        yield* offerRuntimeEvent({
          type: "turn.aborted",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: ctx.activeTurnId,
          payload: { reason: "Interrupted by user" },
        });
      });

    // Wolf has no permission system, so it never opens an approval or
    // user-input request and nothing can be pending to answer.
    const respondToRequest: WolfAdapterShape["respondToRequest"] = (threadId, requestId) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: `Wolf does not issue approval requests (thread ${threadId}, request ${requestId}).`,
      });

    const respondToUserInput: WolfAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: `Wolf does not issue user-input requests (thread ${threadId}, request ${requestId}).`,
      });

    const readThread: WolfAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: WolfAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSessionInternal = (ctx: WolfSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.settle) yield* Deferred.succeed(ctx.settle, undefined).pipe(Effect.ignore);
        sessions.delete(ctx.threadId);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const stopSession: WolfAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: WolfAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: WolfAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: WolfAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to stop Wolf sessions on shutdown.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies WolfAdapterShape;
  });
}
