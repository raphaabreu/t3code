import { describe, expect, it } from "@effect/vitest";

import {
  getBuiltInClaudeModelsForVersion,
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
  resolveClaudeEffort,
} from "./ClaudeProvider.ts";

const slugsFor = (version: string | null) =>
  getBuiltInClaudeModelsForVersion(version).map((model) => model.slug);

describe("Claude Fable 5.1 availability", () => {
  it("is offered from the first Claude Code build that ships it", () => {
    // 2.1.251 and 2.1.252 carry no `claude-fable-5-1` and npm published
    // nothing between 2.1.252 and 2.1.257, so 2.1.257 is the real boundary.
    expect(slugsFor("2.1.257")).toContain("claude-fable-5-1");
    expect(slugsFor("2.1.258")).toContain("claude-fable-5-1");
  });

  it("is withheld from older builds that would reject the slug", () => {
    for (const version of ["2.1.252", "2.1.251", "2.1.219", "2.1.169"]) {
      expect(slugsFor(version)).not.toContain("claude-fable-5-1");
    }
  });

  it("keeps Fable 5 available on builds too old for 5.1", () => {
    expect(slugsFor("2.1.252")).toContain("claude-fable-5");
  });

  it("is withheld when the version could not be determined", () => {
    expect(slugsFor(null)).not.toContain("claude-fable-5-1");
  });

  it("leads the catalog so it is the first Fable shown", () => {
    const slugs = slugsFor("2.1.257");
    expect(slugs.indexOf("claude-fable-5-1")).toBeLessThan(slugs.indexOf("claude-fable-5"));
  });
});

describe("Claude Fable 5.1 capabilities", () => {
  const capabilities = getClaudeModelCapabilities("claude-fable-5-1");

  it("offers the same reasoning and context-window controls as Fable 5", () => {
    const ids = (capabilities.optionDescriptors ?? []).map((descriptor) => descriptor.id);
    expect(ids).toContain("effort");
    expect(ids).toContain("contextWindow");
  });

  it("passes xhigh through instead of remapping it to max", () => {
    // Models without native xhigh are lifted to max; Fable 5.1 supports it.
    const effort = resolveClaudeEffort(capabilities, "xhigh");
    expect(normalizeClaudeCliEffort(effort, "claude-fable-5-1")).toBe("xhigh");
    expect(normalizeClaudeCliEffort(effort, "claude-opus-4-6")).toBe("max");
  });
});
