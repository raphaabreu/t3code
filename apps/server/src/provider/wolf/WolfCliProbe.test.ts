/**
 * Optional integration check against a real `wolf --mode rpc` install.
 * Enable with: T3_WOLF_PROBE=1 vp test run WolfCliProbe
 * Set T3_WOLF_LIVE_TURN=1 to also send a small prompt to the real model.
 *
 * The live turn assumes wolf has credentials for at least one provider
 * (`wolf` then `/login`). Without them the turn arrives as a `turn.completed`
 * carrying `state: "failed"`, which the assertions surface.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type ProviderRuntimeEvent, ThreadId, WolfSettings } from "@t3tools/contracts";
import { assert, describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeWolfAdapter } from "../Layers/WolfAdapter.ts";
import { checkWolfProviderStatus } from "../Layers/WolfProvider.ts";

const decodeWolfSettings = Schema.decodeSync(WolfSettings);
const liveSettings = decodeWolfSettings({ enabled: true });

const LIVE_TURN_TIMEOUT_MS = 180_000;

const collect = (stream: Stream.Stream<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Effect.forkScoped(Stream.runForEach(stream, (event) => Queue.offer(queue, event)));
    const seen: Array<ProviderRuntimeEvent> = [];
    const waitFor = <T extends ProviderRuntimeEvent["type"]>(
      type: T,
    ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: T }>> =>
      Effect.gen(function* () {
        const matches = (
          event: ProviderRuntimeEvent,
        ): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type;
        for (;;) {
          const existing = seen.find(matches);
          if (existing) return existing;
          seen.push(yield* Queue.take(queue));
        }
      });
    return { waitFor, seen } as const;
  });

describe.runIf(process.env.T3_WOLF_PROBE === "1")("Wolf CLI probe", () => {
  it.effect(
    "reports a live snapshot with version, models, and auth from the installed wolf",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* checkWolfProviderStatus(liveSettings, process.env, process.cwd());
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(snapshot.models.length).toBeGreaterThan(0);
        // Every discovered slug is the provider/id pair the CLI accepts.
        for (const model of snapshot.models) {
          expect(model.slug).toContain("/");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.effect.runIf(process.env.T3_WOLF_LIVE_TURN === "1")(
    "delivers a second turn sent while the first is still running",
    () =>
      Effect.gen(function* () {
        // Reproduces the reported failure against the real CLI: a prompt
        // admitted mid-stream without a streaming behavior is refused with
        // "Agent is already processing".
        const cwd = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wolf-steer-probe-")),
        );
        const threadId = ThreadId.make(`wolf-steer-${yield* Clock.currentTimeMillis}`);
        const adapter = yield* makeWolfAdapter(liveSettings);
        const events = yield* collect(adapter.streamEvents);

        yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
        const first = yield* Effect.forkScoped(
          adapter.sendTurn({ threadId, input: "Write a haiku about wolves." }),
        );
        yield* events.waitFor("turn.started");

        const second = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: "Also mention the moon." }),
        );
        assert.isTrue(second._tag === "Success");
        yield* Fiber.await(first);
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-wolf-steer-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    { timeout: LIVE_TURN_TIMEOUT_MS },
  );

  it.effect.runIf(process.env.T3_WOLF_LIVE_TURN === "1")(
    "runs a real turn and resumes the same session after a restart",
    () =>
      Effect.gen(function* () {
        const cwd = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wolf-live-probe-")),
        );
        const threadId = ThreadId.make(`wolf-probe-${yield* Clock.currentTimeMillis}`);

        const first = yield* Effect.gen(function* () {
          const adapter = yield* makeWolfAdapter(liveSettings);
          const events = yield* collect(adapter.streamEvents);
          yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
          yield* adapter.sendTurn({
            threadId,
            input: "Remember the secret word is BANANA. Reply with just: ok",
          });
          const completed = yield* events.waitFor("turn.completed");
          const usage = yield* events.waitFor("thread.token-usage.updated");
          yield* adapter.stopSession(threadId);
          return { completed, usage, seen: events.seen } as const;
        }).pipe(Effect.scoped);

        expect(first.completed.payload.state).toBe("completed");
        expect(first.usage.payload.usage.inputTokens).toBeGreaterThan(0);
        expect(first.seen.some((event) => event.type === "content.delta")).toBe(true);

        // A fresh adapter is a fresh process: only --session-id can carry the
        // conversation across, which is what a server restart relies on.
        const second = yield* Effect.gen(function* () {
          const adapter = yield* makeWolfAdapter(liveSettings);
          const events = yield* collect(adapter.streamEvents);
          yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
          yield* adapter.sendTurn({
            threadId,
            input: "What was the secret word? Reply with just the word.",
          });
          const completed = yield* events.waitFor("turn.completed");
          const text = events.seen
            .filter((event) => event.type === "content.delta")
            .map(
              (event) =>
                (event as Extract<ProviderRuntimeEvent, { type: "content.delta" }>).payload.delta,
            )
            .join("");
          yield* adapter.stopSession(threadId);
          return { completed, text } as const;
        }).pipe(Effect.scoped);

        expect(second.completed.payload.state).toBe("completed");
        expect(second.text.toUpperCase()).toContain("BANANA");
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-wolf-probe-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    { timeout: LIVE_TURN_TIMEOUT_MS },
  );
});
