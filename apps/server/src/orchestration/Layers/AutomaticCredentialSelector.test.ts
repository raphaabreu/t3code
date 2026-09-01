// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { AutomaticCredentialSelector } from "../Services/AutomaticCredentialSelector.ts";
import { AutomaticCredentialSelectorLive } from "./AutomaticCredentialSelector.ts";

const anchorInstanceId = ProviderInstanceId.make("cdp_anchor");
const pickedInstanceId = ProviderInstanceId.make("cdp_picked");
const decodeHelperArgs = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const providers = [anchorInstanceId, pickedInstanceId].map((instanceId) => ({
  instanceId,
  driver: "codex",
  displayName: `Codex ${instanceId}`,
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
  slashCommands: [],
  skills: [],
  continuation: { groupKey: "codex:home:/shared" },
}));

const selectorLayer = effectIt.layer(
  AutomaticCredentialSelectorLive.pipe(
    Layer.provide(makeProviderRegistryLayer(providers as never)),
    Layer.provide(NodeServices.layer),
  ),
);

function withHelperPath(path: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.T3_CDP_PATH;
      process.env.T3_CDP_PATH = path;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3_CDP_PATH;
        else process.env.T3_CDP_PATH = previous;
      }),
  );
}

selectorLayer("AutomaticCredentialSelector", (it) => {
  it.effect(
    "keeps the selected credential before the first session without invoking the helper",
    () =>
      Effect.gen(function* () {
        yield* withHelperPath("/path/that/must/not/run");
        const selector = yield* AutomaticCredentialSelector;
        const resolved = yield* selector.resolve({
          selection: {
            instanceId: anchorInstanceId,
            model: "gpt-5.4",
            credentialMode: "automatic",
          },
        });
        expect(resolved.instanceId).toBe(anchorInstanceId);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps a healthy current credential without invoking the helper", () =>
    Effect.gen(function* () {
      yield* withHelperPath("/path/that/must/not/run");
      const selector = yield* AutomaticCredentialSelector;
      const resolved = yield* selector.resolve({
        selection: {
          instanceId: anchorInstanceId,
          model: "gpt-5.4",
          credentialMode: "automatic",
        },
        currentInstanceId: anchorInstanceId,
      });
      expect(resolved.instanceId).toBe(anchorInstanceId);
    }).pipe(Effect.scoped),
  );

  it.effect("excludes a limited credential and accepts the helper's synchronized replacement", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auto-selector-"))),
        (path) =>
          Effect.sync(() => {
            NodeFS.rmSync(path, { recursive: true, force: true });
          }),
      );
      const helperPath = NodePath.join(tempDir, "fake-cdp");
      const argsPath = NodePath.join(tempDir, "args.json");
      const escapedArgsPath = argsPath.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
      yield* Effect.sync(() => {
        NodeFS.writeFileSync(
          helperPath,
          `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync('${escapedArgsPath}',JSON.stringify(process.argv.slice(2)));process.stdout.write(JSON.stringify({version:1,driver:'codex',profile:'picked',instanceId:'${pickedInstanceId}'})+'\\n');\n`,
          { mode: 0o755 },
        );
      });
      yield* withHelperPath(helperPath);
      const selector = yield* AutomaticCredentialSelector;
      yield* selector.markUnavailable({
        instanceId: anchorInstanceId,
        retryAt: Number.MAX_SAFE_INTEGER,
      });
      const resolved = yield* selector.resolve({
        selection: {
          instanceId: anchorInstanceId,
          model: "gpt-5.4",
          credentialMode: "automatic",
        },
        currentInstanceId: anchorInstanceId,
      });
      expect(resolved.instanceId).toBe(pickedInstanceId);
      expect(decodeHelperArgs(NodeFS.readFileSync(argsPath, "utf8"))).toEqual([
        "--select-auto",
        "--json",
        "--exclude-instance",
        anchorInstanceId,
      ]);
    }).pipe(Effect.scoped),
  );
});
