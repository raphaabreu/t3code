import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderAdapterRequestError } from "../../provider/Errors.ts";

export interface AutomaticCredentialSelectorShape {
  readonly resolve: (input: {
    readonly selection: ModelSelection;
  }) => Effect.Effect<ModelSelection, ProviderAdapterRequestError>;

  readonly markUnavailable: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly retryAt?: number | undefined;
  }) => Effect.Effect<void>;

  readonly isUnavailable: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
}

export class AutomaticCredentialSelector extends Context.Service<
  AutomaticCredentialSelector,
  AutomaticCredentialSelectorShape
>()("t3/orchestration/Services/AutomaticCredentialSelector") {}
