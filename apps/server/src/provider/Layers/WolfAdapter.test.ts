// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  type ProviderRuntimeEvent,
  ThreadId,
  WolfSettings,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { WolfAdapterShape } from "../Services/WolfAdapter.ts";
import { makeWolfAdapter, runtimeModeWarning, splitWolfModel } from "./WolfAdapter.ts";

const decodeWolfSettings = Schema.decodeSync(WolfSettings);

class WolfAdapter extends Context.Service<WolfAdapter, WolfAdapterShape>()(
  "t3/provider/Layers/WolfAdapter.test/WolfAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/wolf-rpc-mock-agent.ts");

async function makeMockWolfWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wolf-rpc-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-wolf.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec node ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

/**
 * Runtime events are consumed from a queue fed by a forked drain so a test can
 * await a specific event without racing the adapter's publication.
 */
const collectEvents = (adapter: WolfAdapterShape) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Effect.forkScoped(
      Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)),
    );
    const seen: Array<ProviderRuntimeEvent> = [];
    // Narrowing on `type` keeps each assertion against the payload the schema
    // actually declares for that event.
    const waitFor = <T extends ProviderRuntimeEvent["type"]>(
      type: T,
      predicate?: (event: Extract<ProviderRuntimeEvent, { type: T }>) => boolean,
    ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: T }>> =>
      Effect.gen(function* () {
        const matches = (
          event: ProviderRuntimeEvent,
        ): event is Extract<ProviderRuntimeEvent, { type: T }> =>
          event.type === type &&
          (predicate === undefined ||
            predicate(event as Extract<ProviderRuntimeEvent, { type: T }>));
        for (;;) {
          const existing = seen.find(matches);
          if (existing) return existing;
          const next = yield* Queue.take(queue);
          seen.push(next);
        }
      });
    return { waitFor, seen } as const;
  });

const makeAdapter = (wrapperPath: string) =>
  Effect.gen(function* () {
    const config = decodeWolfSettings({ enabled: true, binaryPath: wrapperPath });
    return yield* makeWolfAdapter(config);
  });

const wolfAdapterTestLayer = it.layer(
  Layer.effect(
    WolfAdapter,
    Effect.gen(function* () {
      // Replaced per test by a scoped adapter; this instance only satisfies
      // the layer for tests that do not spawn a session.
      const config = decodeWolfSettings({ enabled: true, binaryPath: "wolf" });
      return yield* makeWolfAdapter(config);
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-wolf-adapter-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

wolfAdapterTestLayer("WolfAdapter", (it) => {
  it.effect("streams a full turn and settles only on agent_settled", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_EMIT_TOOL_CALL: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-1");

      const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.equal(session.status, "ready");
      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "t3-wolf-thread-1",
      });

      const result = yield* adapter.sendTurn({ threadId, input: "hello" });

      const delta = yield* events.waitFor("content.delta");
      assert.equal(delta.payload.streamKind, "assistant_text");

      const toolStarted = yield* events.waitFor(
        "item.started",
        (event) => event.payload.itemType === "command_execution",
      );
      assert.equal(toolStarted.payload.title, "bash");

      const toolCompleted = yield* events.waitFor(
        "item.completed",
        (event) => event.payload.itemType === "command_execution",
      );
      assert.equal(toolCompleted.payload.status, "completed");

      const usage = yield* events.waitFor("thread.token-usage.updated");
      assert.equal(usage.payload.usage.inputTokens, 100);
      assert.equal(usage.payload.usage.outputTokens, 20);

      const completed = yield* events.waitFor("turn.completed");
      assert.equal(completed.payload.state, "completed");
      assert.equal(completed.turnId, result.turnId);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed turn carried by turn_end as a runtime error", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_FAIL_TURN: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-error");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const completed = yield* events.waitFor("turn.completed");
      assert.equal(completed.payload.state, "failed");
      assert.equal(completed.payload.errorMessage, "Mock wolf failure.");

      const error = yield* events.waitFor("runtime.error");
      assert.equal(error.payload.class, "provider_error");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("tolerates non-JSON noise and unsolicited extension events on stdout", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_EMIT_LEADING_NOISE: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-noise");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const completed = yield* events.waitFor("turn.completed");
      assert.equal(completed.payload.state, "completed");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("fails the turn instead of hanging when the process dies mid-prompt", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_EXIT_ON_PROMPT: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const threadId = ThreadId.make("wolf-thread-dead");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "hello" }));
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("fails the turn when wolf dies after acknowledging the prompt", () =>
    Effect.gen(function* () {
      // Wolf acks `prompt` before the turn runs, so this crash window leaves
      // nothing to emit `agent_settled`; the turn must still settle.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_EXIT_AFTER_ACK: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-crash");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const completed = yield* events.waitFor("turn.completed");
      assert.equal(completed.payload.state, "failed");
      assert.match(String(completed.payload.errorMessage), /exited before finishing/);

      const exited = yield* events.waitFor("session.exited");
      assert.equal(exited.payload.exitKind, "error");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a completed turn successful when wolf exits right after it", () =>
    Effect.gen(function* () {
      // Teardown hangs off end-of-stream rather than the process exit event,
      // which fires before stdout drains. This is a smoke test for that
      // ordering, not a proof: the underlying race is timing-dependent.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_EXIT_AFTER_TURN: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-exit-after-turn");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const completed = yield* events.waitFor("turn.completed");
      assert.equal(completed.payload.state, "completed");
      const usage = yield* events.waitFor("thread.token-usage.updated");
      assert.equal(usage.payload.usage.inputTokens, 100);
    }).pipe(Effect.scoped),
  );

  it.effect("reports the provider error rather than the exit when both occur", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_FAIL_TURN: "1", T3_WOLF_MOCK_EXIT_AFTER_TURN: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-error-then-exit");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const completed = yield* events.waitFor("turn.completed");
      assert.equal(completed.payload.state, "failed");
      assert.equal(completed.payload.errorMessage, "Mock wolf failure.");
    }).pipe(Effect.scoped),
  );

  it.effect("drops a crashed session so it stops being routable", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_EXIT_AFTER_ACK: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-unregister");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* events.waitFor("session.exited");

      // A wedged session would still answer hasSession and block recovery.
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.equal((yield* adapter.listSessions()).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a request issued after the process is gone", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_EXIT_AFTER_ACK: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-dead-request");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* events.waitFor("session.exited");

      // A second turn must fail fast rather than wait on a dead process.
      const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "again" }));
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("interrupting a hung turn releases the waiter and reports the abort", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockWolfWrapper({ T3_WOLF_MOCK_HANG_TURN: "1" }),
      );
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-abort");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const turnFiber = yield* Effect.forkScoped(adapter.sendTurn({ threadId, input: "hello" }));
      yield* events.waitFor("turn.started");

      yield* adapter.interruptTurn(threadId);
      yield* events.waitFor("turn.aborted");
      yield* Fiber.await(turnFiber);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an empty turn before spawning any work", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockWolfWrapper());
      const adapter = yield* makeAdapter(wrapperPath);
      const threadId = ThreadId.make("wolf-thread-empty");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "   " }));
      assert.isTrue(exit._tag === "Failure");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("warns that approval modes cannot be honored", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockWolfWrapper());
      const adapter = yield* makeAdapter(wrapperPath);
      const events = yield* collectEvents(adapter);
      const threadId = ThreadId.make("wolf-thread-approval");

      yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
      const warning = yield* events.waitFor("config.warning");
      assert.match(String(warning.payload.summary), /no permission system/);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("reports that wolf never opens approval requests", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockWolfWrapper());
      const adapter = yield* makeAdapter(wrapperPath);
      const threadId = ThreadId.make("wolf-thread-no-approval");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const exit = yield* Effect.exit(
        adapter.respondToRequest(threadId, ApprovalRequestId.make("req-1"), "accept"),
      );
      assert.isTrue(exit._tag === "Failure");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("stops tracking a session after stopSession", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockWolfWrapper());
      const adapter = yield* makeAdapter(wrapperPath);
      const threadId = ThreadId.make("wolf-thread-stop");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.isTrue(yield* adapter.hasSession(threadId));
      assert.equal((yield* adapter.listSessions()).length, 1);

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.equal((yield* adapter.listSessions()).length, 0);
    }).pipe(Effect.scoped),
  );
});

it("splits a wolf provider/model pattern for set_model", () => {
  assert.deepEqual(splitWolfModel("openai-codex/gpt-5.6-sol"), {
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
  });
  // A bare id has no provider half, so it cannot drive set_model.
  assert.equal(splitWolfModel("gpt-5.6-sol"), undefined);
  assert.equal(splitWolfModel(undefined), undefined);
});

it("warns only for the runtime modes wolf cannot honor", () => {
  assert.isString(runtimeModeWarning("approval-required"));
  assert.isString(runtimeModeWarning("auto-accept-edits"));
  assert.equal(runtimeModeWarning("full-access"), undefined);
});
