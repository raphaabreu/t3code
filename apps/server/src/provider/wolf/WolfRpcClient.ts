/**
 * WolfRpcClient — one `wolf --mode rpc` child process, framed as JSONL.
 *
 * Owns the process for a single thread: writes commands on stdin, decodes
 * stdout records, correlates responses by request id, and publishes agent
 * events to a queue the adapter drains. Closing the scope kills the process.
 *
 * @module provider/wolf/WolfRpcClient
 */
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../Errors.ts";
import { decodeWolfRecord, splitJsonLines, type WolfRpcRecord } from "./WolfRpcProtocol.ts";

const PROVIDER = "wolf";

/** Agent events, in stdout order. `undefined` closes the stream. */
export interface WolfEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface WolfRpcClientOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly threadId: string;
  /** Called for every stdout record, before response correlation. */
  readonly onRecord?: ((record: WolfRpcRecord) => Effect.Effect<void>) | undefined;
  readonly onStderr?: ((line: string) => Effect.Effect<void>) | undefined;
}

export interface WolfRpcClient {
  readonly pid: number;
  /** Send a command and await its correlated response payload. */
  readonly request: (
    command: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, ProviderAdapterRequestError>;
  /** Send a command without awaiting a response. */
  readonly notify: (
    command: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly events: Stream.Stream<WolfEvent>;
  /** False once stdout has ended, whether or not the OS handle lingers. */
  readonly isRunning: Effect.Effect<boolean>;
  /** Resolves when the process exits, so callers can race it against a wait. */
  readonly awaitExit: Effect.Effect<void>;
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, ProviderAdapterRequestError>;
  readonly command: string;
}

export const makeWolfRpcClient = (
  options: WolfRpcClientOptions,
): Effect.Effect<
  WolfRpcClient,
  ProviderAdapterProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const runtimeScope = yield* Scope.Scope;

    const processError = (detail: string, cause?: unknown) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: options.threadId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    // Windows installs Wolf as a `.cmd` shim, which only launches through a
    // shell; every other CLI spawn in the server resolves the same way.
    const spawnCommand = yield* resolveSpawnCommand(
      options.command,
      [...options.args],
      options.env ? { env: options.env, extendEnv: true } : {},
    ).pipe(
      Effect.mapError((cause) => processError(`Failed to resolve '${options.command}'.`, cause)),
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          ...(options.env ? { env: options.env, extendEnv: true } : {}),
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError((cause) => processError(`Failed to spawn '${options.command}'.`, cause)),
      );

    const events = yield* Queue.unbounded<WolfEvent>();
    const outbound = yield* Queue.unbounded<string>();
    const pending = yield* Ref.make(new Map<string, PendingRequest>());
    // Latched once the process is gone. Without it a request issued after exit
    // registers a deferred that nothing will ever settle.
    const exited = yield* Ref.make(false);

    yield* Stream.run(Stream.encodeText(Stream.fromQueue(outbound)), child.stdin).pipe(
      Effect.catch((cause) =>
        Effect.logDebug("Wolf RPC stdin closed.", { cause, threadId: options.threadId }),
      ),
      Effect.forkIn(runtimeScope),
    );

    const failAllPending = (detail: string) =>
      Ref.getAndSet(pending, new Map<string, PendingRequest>()).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries.values(),
            (entry) =>
              Deferred.fail(
                entry.deferred,
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: entry.command,
                  detail,
                }),
              ).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const handleRecord = (record: WolfRpcRecord) =>
      Effect.gen(function* () {
        if (options.onRecord) yield* options.onRecord(record);
        if (record.kind === "event") {
          yield* Queue.offer(events, { type: record.type, payload: record.payload });
          return;
        }
        if (record.kind !== "response" || record.id === undefined) return;
        const entry = yield* Ref.modify(pending, (current) => {
          const found = current.get(record.id as string);
          if (!found) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(record.id as string);
          return [found, next] as const;
        });
        if (!entry) return;
        yield* record.success
          ? Deferred.succeed(entry.deferred, record.data)
          : Deferred.fail(
              entry.deferred,
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: entry.command,
                detail: record.error ?? `Wolf rejected '${entry.command}'.`,
              }),
            );
      });

    const stdoutRemainder = yield* Ref.make("");
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stdoutRemainder, (current) => {
          const { lines, rest } = splitJsonLines(current + chunk);
          return [lines, rest] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const record = decodeWolfRecord(line);
                return record ? handleRecord(record) : Effect.void;
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logDebug("Wolf RPC stdout ended.", { cause, threadId: options.threadId }),
      ),
      // stdout ending means the process is gone: nothing will ever answer an
      // outstanding request, so settle them instead of leaking the wait.
      Effect.ensuring(
        Ref.set(exited, true).pipe(
          Effect.tap(() => failAllPending("Wolf process exited before responding.")),
          Effect.tap(() => Queue.shutdown(events)),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    if (options.onStderr) {
      const onStderr = options.onStderr;
      const stderrRemainder = yield* Ref.make("");
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.modify(stderrRemainder, (current) => {
            const { lines, rest } = splitJsonLines(current + chunk);
            return [lines, rest] as const;
          }).pipe(
            Effect.flatMap((lines) =>
              Effect.forEach(lines, (line) => (line.trim() ? onStderr(line) : Effect.void), {
                discard: true,
              }),
            ),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
    }

    const write = (payload: Record<string, unknown>) =>
      Queue.offer(outbound, `${JSON.stringify(payload)}\n`).pipe(Effect.asVoid);

    const notify: WolfRpcClient["notify"] = (command, params) =>
      write({ type: command, ...params });

    const request: WolfRpcClient["request"] = (command, params) =>
      Effect.gen(function* () {
        if (yield* Ref.get(exited)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: command,
            detail: "Wolf process is no longer running.",
          });
        }
        const id = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: command,
                detail: "Failed to generate a Wolf request id.",
                cause,
              }),
          ),
        );
        const deferred = yield* Deferred.make<unknown, ProviderAdapterRequestError>();
        yield* Ref.update(pending, (current) => {
          const next = new Map(current);
          next.set(id, { deferred, command });
          return next;
        });
        yield* write({ id, type: command, ...params });
        // The exit latch can flip between the check above and registration, so
        // re-check rather than waiting on a deferred nothing will settle.
        if (yield* Ref.get(exited)) {
          yield* failAllPending("Wolf process is no longer running.");
        }
        return yield* Deferred.await(deferred);
      });

    yield* Effect.addFinalizer(() =>
      Queue.shutdown(outbound).pipe(
        Effect.tap(() => child.kill().pipe(Effect.ignore)),
        Effect.tap(() => failAllPending("Wolf session stopped.")),
      ),
    );

    return {
      pid: child.pid,
      request,
      notify,
      events: Stream.fromQueue(events),
      isRunning: Ref.get(exited).pipe(Effect.map((dead) => !dead)),
      awaitExit: child.exitCode.pipe(Effect.ignore, Effect.asVoid),
    } satisfies WolfRpcClient;
  });
