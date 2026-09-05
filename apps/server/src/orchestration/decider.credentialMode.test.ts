import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

it.layer(NodeServices.layer)("session credential policy", (it) => {
  for (const mode of ["automatic", null] as const) {
    it.effect(`changes policy to ${mode} without replacing the live account or model`, () =>
      Effect.gen(function* () {
        const thread = readModel.threads[0]!;
        const liveSelection = {
          instanceId: ProviderInstanceId.make("codex_after_failover"),
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
          ...(mode === null ? { credentialMode: "automatic" as const } : {}),
        };
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("policy-update"),
            threadId: thread.id,
            credentialMode: mode,
          },
          readModel: { ...readModel, threads: [{ ...thread, modelSelection: liveSelection }] },
        });
        const event = Array.isArray(result) ? result[0] : result;
        expect(event.type).toBe("thread.meta-updated");
        if (event.type === "thread.meta-updated") {
          expect(event.payload.modelSelection).toEqual({
            instanceId: liveSelection.instanceId,
            model: liveSelection.model,
            options: liveSelection.options,
            ...(mode ? { credentialMode: mode } : {}),
          });
        }
      }),
    );
  }
});
