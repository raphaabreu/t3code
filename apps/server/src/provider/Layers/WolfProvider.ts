/**
 * WolfProvider — snapshot probing for the Wolf CLI.
 *
 * Version comes from `wolf --version`; models and authentication come from a
 * short-lived `wolf --mode rpc --no-session` process, which reports the same
 * catalog the interactive CLI would use.
 *
 * @module WolfProvider
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type WolfSettings,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../Errors.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeWolfRpcClient } from "../wolf/WolfRpcClient.ts";
import { resolveWolfBinary } from "../wolf/WolfCli.ts";

const WOLF_PRESENTATION = {
  displayName: "Wolf",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

/**
 * Used before the live catalog arrives and whenever discovery fails, so the
 * model picker is never empty for an installed Wolf.
 */
const WOLF_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "openai-codex/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function wolfModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = WOLF_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wolf model ids are unique only within a provider, so the T3 slug is the
 * `provider/id` pair that `--model` and `set_model` both accept.
 */
export function wolfModelsFromRpcCatalog(data: unknown): ReadonlyArray<ServerProviderModel> {
  const models = isRecord(data) ? data.models : undefined;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const result: Array<ServerProviderModel> = [];
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (!id || !provider) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
    result.push({
      slug,
      name,
      shortName: name,
      subProvider: provider,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return result;
}

interface WolfRpcProbeResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly auth: ServerProviderAuth;
}

/**
 * A model list means Wolf resolved credentials for at least one provider; an
 * empty catalog means it is installed but not logged in anywhere.
 */
const probeWolfViaRpc = (
  wolfSettings: WolfSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<
  WolfRpcProbeResult,
  ProviderAdapterProcessError | ProviderAdapterRequestError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const client = yield* makeWolfRpcClient({
      command: resolveWolfBinary(wolfSettings),
      args: ["--mode", "rpc", "--no-session"],
      cwd,
      env: environment,
      threadId: "wolf-provider-probe",
    });
    const data = yield* client.request("get_available_models");
    const models = wolfModelsFromRpcCatalog(data);
    return {
      models,
      auth: {
        status: models.length > 0 ? "authenticated" : "unauthenticated",
      },
    } satisfies WolfRpcProbeResult;
  }).pipe(Effect.scoped);

const runWolfVersionCommand = (wolfSettings: WolfSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = resolveWolfBinary(wolfSettings);
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
      extendEnv: true,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialWolfProviderSnapshot(
  wolfSettings: WolfSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = wolfModelsFromSettings(wolfSettings.customModels);
    return buildServerProvider({
      presentation: WOLF_PRESENTATION,
      enabled: wolfSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: wolfSettings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: wolfSettings.enabled
          ? "Checking Wolf CLI availability..."
          : "Wolf is disabled in T3 Code settings.",
      },
    });
  });
}

export const checkWolfProviderStatus = Effect.fn("checkWolfProviderStatus")(function* (
  wolfSettings: WolfSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = wolfModelsFromSettings(wolfSettings.customModels);

  if (!wolfSettings.enabled) {
    return buildServerProvider({
      presentation: WOLF_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Wolf is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runWolfVersionCommand(wolfSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Wolf CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: WOLF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Wolf CLI (`wolf`) is not installed or not on PATH."
          : "Failed to execute Wolf CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: WOLF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Wolf CLI is installed but timed out while running `wolf --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: WOLF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Wolf CLI is installed but failed to run.",
      },
    });
  }

  const probeExit = yield* probeWolfViaRpc(wolfSettings, environment, cwd).pipe(
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );

  if (Exit.isFailure(probeExit)) {
    yield* Effect.logWarning("Wolf RPC model discovery failed.", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return buildServerProvider({
      presentation: WOLF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Wolf CLI is installed but its RPC mode failed to start.",
      },
    });
  }

  if (Option.isNone(probeExit.value)) {
    return buildServerProvider({
      presentation: WOLF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Wolf RPC startup timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const probe = probeExit.value.value;
  const models =
    probe.models.length > 0
      ? wolfModelsFromSettings(wolfSettings.customModels, probe.models)
      : fallbackModels;

  return buildServerProvider({
    presentation: WOLF_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: probe.auth.status === "authenticated" ? "ready" : "warning",
      auth: probe.auth,
      ...(probe.auth.status === "authenticated"
        ? {}
        : { message: "Wolf is installed but has no configured provider. Run `wolf` and /login." }),
    },
  });
});

export const enrichWolfSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Wolf version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
