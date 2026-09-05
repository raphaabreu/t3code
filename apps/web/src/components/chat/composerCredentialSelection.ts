import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

interface ComposerCredentialDraftState {
  readonly activeProvider: ProviderInstanceId | null;
  readonly modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  readonly modelSelectionExplicit?: boolean | undefined;
}

export function orderComposerProviderInstanceCandidates(input: {
  readonly draft: ComposerCredentialDraftState;
  readonly sessionInstanceId: ProviderInstanceId | null | undefined;
  readonly threadModelSelection: ModelSelection | null | undefined;
  readonly projectInstanceId: ProviderInstanceId | null | undefined;
}): ReadonlyArray<ProviderInstanceId> {
  const draftActiveSelection = input.draft.activeProvider
    ? input.draft.modelSelectionByProvider[input.draft.activeProvider]
    : undefined;
  const explicitFixedDraftInstanceId =
    input.draft.modelSelectionExplicit === true &&
    draftActiveSelection?.credentialMode !== "automatic"
      ? input.draft.activeProvider
      : null;

  if (input.threadModelSelection) {
    return [
      explicitFixedDraftInstanceId,
      input.threadModelSelection.instanceId,
      input.sessionInstanceId,
      input.draft.activeProvider,
      input.projectInstanceId,
    ].filter((candidate): candidate is ProviderInstanceId => candidate != null);
  }

  return [input.draft.activeProvider, input.sessionInstanceId, input.projectInstanceId].filter(
    (candidate): candidate is ProviderInstanceId => candidate != null,
  );
}

export function resolveComposerCredentialMode(input: {
  readonly draft: ComposerCredentialDraftState;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly threadModelSelection: ModelSelection | null | undefined;
}): ModelSelection["credentialMode"] {
  // Persisted session policy is authoritative across devices and account switches.
  // Drafts own the preference only until the thread is created.
  if (input.threadModelSelection) return input.threadModelSelection.credentialMode;
  return input.draft.modelSelectionByProvider[input.selectedInstanceId]?.credentialMode;
}
