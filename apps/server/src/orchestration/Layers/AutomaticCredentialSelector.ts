// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  AutomaticCredentialSelector,
  type AutomaticCredentialSelectorShape,
} from "../Services/AutomaticCredentialSelector.ts";

const AutomaticCredentialPick = Schema.Struct({
  version: Schema.Literal(1),
  driver: Schema.Literals(["claudeAgent", "codex"]),
  profile: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  model: Schema.optional(TrimmedNonEmptyString),
});

const decodePickJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AutomaticCredentialPick));

function providerError(driver: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: driver,
    method: "credential.select-auto",
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function commandEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const providerRegistry = yield* ProviderRegistry;
  const unavailableUntil = new Map<ProviderInstanceId, number>();

  const isUnavailableNow = (instanceId: ProviderInstanceId, now: number): boolean => {
    const retryAt = unavailableUntil.get(instanceId);
    if (retryAt === undefined) return false;
    if (retryAt > now) return true;
    unavailableUntil.delete(instanceId);
    return false;
  };

  const helperPath = Effect.fnUntraced(function* (driver: "claudeAgent" | "codex") {
    const override = driver === "claudeAgent" ? process.env.T3_CCP_PATH : process.env.T3_CDP_PATH;
    if (override?.trim()) return override.trim();

    const name = driver === "claudeAgent" ? "ccp" : "cdp";
    const localPath = NodePath.join(NodeOS.homedir(), ".local", "bin", name);
    return (yield* fileSystem.exists(localPath)) ? localPath : name;
  });

  const invokeHelper = Effect.fn("AutomaticCredentialSelector.invokeHelper")(function* (input: {
    readonly driver: "claudeAgent" | "codex";
    readonly model: string;
    readonly excludedInstanceIds: ReadonlyArray<ProviderInstanceId>;
  }) {
    const binary = yield* helperPath(input.driver).pipe(
      Effect.mapError((cause) =>
        providerError(input.driver, "Could not resolve the automatic selector path.", cause),
      ),
    );
    const args = [
      "--select-auto",
      ...(input.driver === "claudeAgent" ? [input.model] : []),
      "--json",
      ...input.excludedInstanceIds.flatMap((instanceId) => [
        "--exclude-instance",
        String(instanceId),
      ]),
    ];
    const child = yield* spawner
      .spawn(
        ChildProcess.make(binary, args, {
          env: commandEnvironment(),
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          providerError(input.driver, `Could not start automatic selector '${binary}'.`, cause),
        ),
      );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout }).pipe(
          Effect.map((collected) => collected.text),
        ),
        collectUint8StreamText({ stream: child.stderr }).pipe(
          Effect.map((collected) => collected.text),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) =>
        providerError(input.driver, "Could not read the automatic selector result.", cause),
      ),
    );
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `Selector exited with code ${exitCode}.`;
      return yield* providerError(input.driver, detail);
    }
    return yield* decodePickJson(stdout).pipe(
      Effect.mapError((cause) =>
        providerError(input.driver, "Automatic selector returned an invalid result.", cause),
      ),
    );
  });

  const resolve: AutomaticCredentialSelectorShape["resolve"] = Effect.fn(
    "AutomaticCredentialSelector.resolve",
  )(function* (input) {
    if (input.selection.credentialMode !== "automatic") {
      return input.selection;
    }

    const providers = yield* providerRegistry.getProviders;
    const now = yield* Clock.currentTimeMillis;
    const anchor = providers.find((provider) => provider.instanceId === input.selection.instanceId);
    if (!anchor) {
      return yield* providerError(
        String(input.selection.instanceId),
        `Automatic credential anchor '${input.selection.instanceId}' is not configured.`,
      );
    }
    const driver = String(anchor.driver);
    if (driver !== "claudeAgent" && driver !== "codex") {
      return yield* providerError(
        String(anchor.driver),
        `Automatic credentials are only supported for Claude and Codex.`,
      );
    }

    const current = input.currentInstanceId
      ? providers.find((provider) => provider.instanceId === input.currentInstanceId)
      : undefined;
    if (
      current &&
      current.driver === anchor.driver &&
      current.continuation?.groupKey === anchor.continuation?.groupKey &&
      !isUnavailableNow(current.instanceId, now)
    ) {
      return { ...input.selection, instanceId: current.instanceId };
    }

    const excludedInstanceIds = [...unavailableUntil.entries()].flatMap(([instanceId, retryAt]) =>
      retryAt > now ? [instanceId] : [],
    );
    const picked = yield* invokeHelper({
      driver,
      model: input.selection.model,
      excludedInstanceIds,
    }).pipe(Effect.scoped);
    const pickedProvider = providers.find((provider) => provider.instanceId === picked.instanceId);
    if (!pickedProvider) {
      return yield* providerError(
        driver,
        `Selector chose '${picked.instanceId}', but that profile is not synchronized into T3 Code. Run ${driver === "claudeAgent" ? "ccp" : "cdp"} --sync-t3.`,
      );
    }
    if (
      picked.driver !== driver ||
      pickedProvider.driver !== anchor.driver ||
      pickedProvider.continuation?.groupKey !== anchor.continuation?.groupKey
    ) {
      return yield* providerError(
        driver,
        `Selector chose incompatible provider instance '${picked.instanceId}'.`,
      );
    }
    if (isUnavailableNow(picked.instanceId, now)) {
      return yield* providerError(
        driver,
        `Selector returned unavailable provider instance '${picked.instanceId}'.`,
      );
    }
    if (
      !pickedProvider.enabled ||
      !pickedProvider.installed ||
      pickedProvider.status !== "ready" ||
      pickedProvider.auth.status !== "authenticated"
    ) {
      return yield* providerError(
        driver,
        `Selector chose provider instance '${picked.instanceId}', but it is not ready in T3 Code.`,
      );
    }
    if (!pickedProvider.models.some((model) => model.slug === input.selection.model)) {
      return yield* providerError(
        driver,
        `Selector chose provider instance '${picked.instanceId}', which does not expose model '${input.selection.model}'.`,
      );
    }
    return { ...input.selection, instanceId: picked.instanceId };
  });

  return {
    resolve,
    markUnavailable: ({ instanceId, retryAt }) =>
      Effect.sync(() => {
        unavailableUntil.set(instanceId, retryAt ?? Number.POSITIVE_INFINITY);
      }),
    isUnavailable: (instanceId) =>
      Clock.currentTimeMillis.pipe(Effect.map((now) => isUnavailableNow(instanceId, now))),
  } satisfies AutomaticCredentialSelectorShape;
});

export const AutomaticCredentialSelectorLive = Layer.effect(AutomaticCredentialSelector, make);
