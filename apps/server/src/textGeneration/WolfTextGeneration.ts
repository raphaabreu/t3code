/**
 * WolfTextGeneration — commit messages, PR content, branch names, and thread
 * titles through a one-shot `wolf --mode rpc --no-session` process.
 *
 * @module textGeneration/WolfTextGeneration
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError, type ModelSelection, type WolfSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { resolveWolfBinary } from "../provider/wolf/WolfCli.ts";
import { makeWolfRpcClient } from "../provider/wolf/WolfRpcClient.ts";
import { isSettleEvent, readTurnEnd } from "../provider/wolf/WolfRuntimeEvents.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const WOLF_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const makeWolfTextGeneration = Effect.fn("makeWolfTextGeneration")(function* (
  wolfSettings: WolfSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runWolfJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const turnErrorRef = yield* Ref.make<string | undefined>(undefined);

      const client = yield* makeWolfRpcClient({
        command: resolveWolfBinary(wolfSettings),
        args: [
          "--mode",
          "rpc",
          "--no-session",
          "--no-tools",
          ...(modelSelection.model ? ["--model", modelSelection.model] : []),
        ],
        cwd,
        env: environment,
        threadId: `wolf-text-${operation}`,
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );

      const settled = yield* Latch.make(false);
      yield* Stream.runForEach(client.events, (event) =>
        Effect.gen(function* () {
          if (event.type === "turn_end") {
            const outcome = readTurnEnd(event.payload);
            if (outcome.errorMessage) yield* Ref.set(turnErrorRef, outcome.errorMessage);
            return;
          }
          if (isSettleEvent(event.type)) {
            yield* settled.open;
            return;
          }
          if (event.type !== "message_update") return;
          const delta = event.payload.assistantMessageEvent;
          if (!isRecord(delta) || delta.type !== "text_delta") return;
          if (typeof delta.delta !== "string") return;
          yield* Ref.update(outputRef, (current) => current + delta.delta);
        }),
      ).pipe(Effect.forkScoped);

      yield* client.request("prompt", { message: prompt }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Wolf rejected the text generation prompt.",
              cause,
            }),
        ),
      );

      yield* settled.await.pipe(
        Effect.timeoutOption(WOLF_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Wolf request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const turnError = yield* Ref.get(turnErrorRef);
      if (turnError) {
        return yield* new TextGenerationError({ operation, detail: turnError });
      }

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "Wolf returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Wolf returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Wolf text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("WolfTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runWolfJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("WolfTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runWolfJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("WolfTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runWolfJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("WolfTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runWolfJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
