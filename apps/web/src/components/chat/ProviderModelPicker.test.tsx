import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

function providerEntry(instanceId: string, driver: string, displayName?: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(displayName ? { displayName } : {}),
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

function renderPicker(input: {
  instanceId: string;
  driver: string;
  model: string;
  options: ReadonlyArray<ModelEsque>;
  includeEntry?: boolean;
  credentialMode?: "automatic";
  showActiveInstanceName?: boolean;
  displayName?: string;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const entry = providerEntry(input.instanceId, input.driver, input.displayName);
  return renderToStaticMarkup(
    <ProviderModelPicker
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={input.includeEntry === false ? [] : [entry]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      credentialMode={input.credentialMode}
      {...(input.showActiveInstanceName ? { showActiveInstanceName: true } : {})}
      onInstanceModelChange={() => {}}
    />,
  );
}

describe("ProviderModelPicker", () => {
  it("shows a missing model slug for a custom OpenCode instance", () => {
    const markup = renderPicker({
      instanceId: "team_runtime",
      driver: "opencode",
      model: "openrouter/missing-model",
      options: [{ slug: "openrouter/fallback", name: "Fallback model" }],
    });

    expect(markup).toContain("openrouter/missing-model");
    expect(markup).not.toContain("Fallback model");
  });

  it.each(["codex", "claudeAgent", "cursor", "grok"])(
    "uses the first option label for a missing %s model",
    (driver) => {
      const markup = renderPicker({
        instanceId: `${driver}_work`,
        driver,
        model: "missing-model",
        options: [{ slug: "fallback-model", name: "Fallback model" }],
      });

      expect(markup).toContain("Fallback model");
      expect(markup).not.toContain(">missing-model<");
    },
  );

  it("prefers a matching model for OpenCode", () => {
    const markup = renderPicker({
      instanceId: "custom_runtime",
      driver: "opencode",
      model: "openrouter/selected",
      options: [
        { slug: "openrouter/fallback", name: "Fallback model" },
        { slug: "openrouter/selected", name: "Selected model" },
      ],
    });

    expect(markup).toContain("Selected model");
    expect(markup).not.toContain("Fallback model");
  });

  it("uses the first option when the active instance entry is missing", () => {
    const markup = renderPicker({
      instanceId: "missing_instance",
      driver: "opencode",
      model: "missing-model",
      options: [{ slug: "fallback-model", name: "Fallback model" }],
      includeEntry: false,
    });

    expect(markup).toContain("Fallback model");
    expect(markup).not.toContain(">missing-model<");
  });

  it("shows when automatic credential failover is enabled", () => {
    const markup = renderPicker({
      instanceId: "codex_work",
      driver: "codex",
      model: "gpt-5.4",
      options: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      credentialMode: "automatic",
    });

    expect(markup).toContain(">Auto<");
  });

  it("shows the active credential profile name when requested", () => {
    const markup = renderPicker({
      instanceId: "claude_aline_profile",
      driver: "claudeAgent",
      model: "claude-opus-5",
      options: [{ slug: "claude-opus-5", name: "Claude Opus 5" }],
      credentialMode: "automatic",
      showActiveInstanceName: true,
      displayName: "Claude · aline.lorenzeto@gmail.com",
    });

    expect(markup).toContain('data-chat-provider-profile-name="true"');
    expect(markup).toContain("Claude · aline.lorenzeto@gmail.com");
    expect(markup).toContain(">Auto<");
  });
});
