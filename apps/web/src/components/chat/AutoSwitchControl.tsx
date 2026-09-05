import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Session policy stays visible independently of the model catalog. */
export function AutoSwitchControl(props: {
  instanceId: ProviderInstanceId;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  enabled: boolean;
  saving: boolean;
  onChange: (mode: "automatic" | null) => void;
}) {
  const active = props.entries.find((entry) => entry.instanceId === props.instanceId);
  const supported = active?.driverKind === "codex" || active?.driverKind === "claudeAgent";
  if (!supported && !props.enabled) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label className="flex shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground" />
        }
      >
        <Checkbox
          checked={props.enabled}
          disabled={props.saving}
          onCheckedChange={(checked) => props.onChange(checked ? "automatic" : null)}
        />
        {props.saving ? "Saving…" : "Auto-switch on limit"}
      </TooltipTrigger>
      <TooltipPopup side="top">
        Keep this model and account until a usage limit interrupts the session, then switch to a
        compatible account and continue.
      </TooltipPopup>
    </Tooltip>
  );
}
