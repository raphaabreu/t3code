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

  if (input.threadModelSelection?.credentialMode === "automatic") {
    return [
      explicitFixedDraftInstanceId,
      input.sessionInstanceId,
      input.threadModelSelection.instanceId,
      input.draft.activeProvider,
      input.projectInstanceId,
    ].filter((candidate): candidate is ProviderInstanceId => candidate != null);
  }

  return [
    input.draft.activeProvider,
    input.sessionInstanceId,
    input.threadModelSelection?.instanceId,
    input.projectInstanceId,
  ].filter((candidate): candidate is ProviderInstanceId => candidate != null);
}

export function resolveComposerCredentialMode(input: {
  readonly draft: ComposerCredentialDraftState;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly threadModelSelection: ModelSelection | null | undefined;
}): ModelSelection["credentialMode"] {
  const draftSelection = input.draft.modelSelectionByProvider[input.selectedInstanceId];
  const explicitDraftSelectionIsAuthoritative =
    input.draft.modelSelectionExplicit === true &&
    input.draft.activeProvider === input.selectedInstanceId;

  if (explicitDraftSelectionIsAuthoritative) {
    return draftSelection?.credentialMode;
  }

  return (
    draftSelection?.credentialMode ??
    (input.threadModelSelection?.instanceId === input.selectedInstanceId
      ? input.threadModelSelection.credentialMode
      : undefined)
  );
}
