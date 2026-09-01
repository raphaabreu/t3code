// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WolfSettings } from "@t3tools/contracts";

import {
  buildInitialWolfProviderSnapshot,
  checkWolfProviderStatus,
  wolfModelsFromRpcCatalog,
} from "./WolfProvider.ts";

const decodeWolfSettings = Schema.decodeSync(WolfSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/wolf-rpc-mock-agent.ts");

async function makeMockWolfWrapper(version = "wolf 1.2608.0") {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wolf-provider-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-wolf.sh");
  const script = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo ${JSON.stringify(version)}
    exit 0
  fi
done
exec node ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

describe("wolfModelsFromRpcCatalog", () => {
  it("keys models by provider/id so slugs are unique across providers", () => {
    const models = wolfModelsFromRpcCatalog({
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-sonnet-5",
    ]);
    expect(models[0]?.subProvider).toBe("openai-codex");
  });

  it("drops entries missing an id or provider and de-duplicates slugs", () => {
    const models = wolfModelsFromRpcCatalog({
      models: [
        { id: "a", provider: "p" },
        { id: "a", provider: "p" },
        { id: "b" },
        { provider: "p" },
        "nonsense",
      ],
    });
    expect(models.map((model) => model.slug)).toEqual(["p/a"]);
  });

  it("returns nothing for a malformed catalog", () => {
    expect(wolfModelsFromRpcCatalog(undefined)).toEqual([]);
    expect(wolfModelsFromRpcCatalog({ models: "no" })).toEqual([]);
  });
});

describe("buildInitialWolfProviderSnapshot", () => {
  it.effect("reports the disabled state without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialWolfProviderSnapshot(decodeWolfSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toMatch(/disabled/);
    }),
  );

  it.effect("keeps a non-empty model list before discovery completes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialWolfProviderSnapshot(
        decodeWolfSettings({ enabled: true }),
      );
      expect(snapshot.models.length).toBeGreaterThan(0);
    }),
  );
});

describe("checkWolfProviderStatus", () => {
  it.effect("reports version, live models, and authenticated status for an installed wolf", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockWolfWrapper());
      const snapshot = yield* checkWolfProviderStatus(
        decodeWolfSettings({ enabled: true, binaryPath: wrapperPath }),
        process.env,
        process.cwd(),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.2608.0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toContain("openai-codex/gpt-5.6-sol");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkWolfProviderStatus(
        decodeWolfSettings({ enabled: true, binaryPath: "definitely-not-a-real-wolf-binary" }),
        process.env,
        process.cwd(),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed/);
      // The picker still offers the built-in fallback rather than going blank.
      expect(snapshot.models.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
