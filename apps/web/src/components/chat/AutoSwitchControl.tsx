import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ZapIcon, ZapOffIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

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
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <ComposerControl
          aria-label="Auto-switch on limit"
          aria-pressed={props.enabled}
          aria-busy={props.saving}
          className="w-7 px-0 aria-pressed:bg-primary/10 aria-pressed:text-primary"
          disabled={props.saving}
          onClick={() => props.onChange(props.enabled ? null : "automatic")}
        >
          <ComposerControlIcon
            icon={props.enabled ? ZapIcon : ZapOffIcon}
            className="text-current"
          />
        </ComposerControl>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.saving
          ? "Saving auto-switch setting…"
          : `Auto-switch on limit: ${props.enabled ? "On" : "Off"}. Switch to a compatible account when a usage limit interrupts the session.`}
      </TooltipPopup>
    </Tooltip>
  );
}
