import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orderComposerProviderInstanceCandidates,
  resolveComposerCredentialMode,
} from "./composerCredentialSelection";

const AUTOMATIC_INSTANCE = ProviderInstanceId.make("ccp_current");
const FAILED_OVER_INSTANCE = ProviderInstanceId.make("ccp_after_failover");
const FIXED_INSTANCE = ProviderInstanceId.make("ccp_fixed");

function selection(instanceId: ProviderInstanceId, credentialMode?: "automatic"): ModelSelection {
  return {
    instanceId,
    model: "claude-opus-5",
    ...(credentialMode ? { credentialMode } : {}),
  };
}

describe("composer credential selection", () => {
  it("shows the live session account while automatic routing remains enabled", () => {
    const automaticSelection = selection(AUTOMATIC_INSTANCE, "automatic");

    expect(
      orderComposerProviderInstanceCandidates({
        draft: {
          activeProvider: AUTOMATIC_INSTANCE,
          modelSelectionByProvider: { [AUTOMATIC_INSTANCE]: automaticSelection },
          modelSelectionExplicit: true,
        },
        sessionInstanceId: FAILED_OVER_INSTANCE,
        threadModelSelection: automaticSelection,
        projectInstanceId: null,
      })[0],
    ).toBe(FAILED_OVER_INSTANCE);
  });

  it("lets an explicit fixed account override an automatic thread", () => {
    const automaticSelection = selection(AUTOMATIC_INSTANCE, "automatic");
    const fixedSelection = selection(FIXED_INSTANCE);

    expect(
      orderComposerProviderInstanceCandidates({
        draft: {
          activeProvider: FIXED_INSTANCE,
          modelSelectionByProvider: { [FIXED_INSTANCE]: fixedSelection },
          modelSelectionExplicit: true,
        },
        sessionInstanceId: AUTOMATIC_INSTANCE,
        threadModelSelection: automaticSelection,
        projectInstanceId: null,
      })[0],
    ).toBe(FIXED_INSTANCE);
  });

  it("keeps the session policy when a model pick omits credential mode", () => {
    const automaticSelection = selection(AUTOMATIC_INSTANCE, "automatic");
    const fixedSelection = selection(AUTOMATIC_INSTANCE);

    expect(
      resolveComposerCredentialMode({
        draft: {
          activeProvider: AUTOMATIC_INSTANCE,
          modelSelectionByProvider: { [AUTOMATIC_INSTANCE]: fixedSelection },
          modelSelectionExplicit: true,
        },
        selectedInstanceId: AUTOMATIC_INSTANCE,
        threadModelSelection: automaticSelection,
      }),
    ).toBe("automatic");
  });

  it("uses the draft preference before creating a session", () => {
    expect(
      resolveComposerCredentialMode({
        draft: {
          activeProvider: AUTOMATIC_INSTANCE,
          modelSelectionByProvider: {
            [AUTOMATIC_INSTANCE]: selection(AUTOMATIC_INSTANCE, "automatic"),
          },
        },
        selectedInstanceId: AUTOMATIC_INSTANCE,
        threadModelSelection: null,
      }),
    ).toBe("automatic");
  });

  it("reflects disabling auto-switch from another device despite a stale draft", () => {
    expect(
      resolveComposerCredentialMode({
        draft: {
          activeProvider: AUTOMATIC_INSTANCE,
          modelSelectionByProvider: {
            [AUTOMATIC_INSTANCE]: selection(AUTOMATIC_INSTANCE, "automatic"),
          },
          modelSelectionExplicit: true,
        },
        selectedInstanceId: AUTOMATIC_INSTANCE,
        threadModelSelection: selection(AUTOMATIC_INSTANCE),
      }),
    ).toBeUndefined();
  });

  it("inherits automatic routing when the draft is only a non-explicit seed", () => {
    const automaticSelection = selection(AUTOMATIC_INSTANCE, "automatic");

    expect(
      resolveComposerCredentialMode({
        draft: {
          activeProvider: AUTOMATIC_INSTANCE,
          modelSelectionByProvider: {
            [AUTOMATIC_INSTANCE]: selection(AUTOMATIC_INSTANCE),
          },
        },
        selectedInstanceId: AUTOMATIC_INSTANCE,
        threadModelSelection: automaticSelection,
      }),
    ).toBe("automatic");
  });

  it("keeps automatic routing visible after failover changes the live instance", () => {
    const automaticSelection = selection(AUTOMATIC_INSTANCE, "automatic");

    expect(
      resolveComposerCredentialMode({
        draft: {
          activeProvider: AUTOMATIC_INSTANCE,
          modelSelectionByProvider: { [AUTOMATIC_INSTANCE]: automaticSelection },
          modelSelectionExplicit: true,
        },
        selectedInstanceId: FAILED_OVER_INSTANCE,
        threadModelSelection: selection(FAILED_OVER_INSTANCE, "automatic"),
      }),
    ).toBe("automatic");
  });
});
