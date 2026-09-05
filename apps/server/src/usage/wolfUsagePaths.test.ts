// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveWolfUsageDirectory } from "./wolfUsagePaths.ts";

describe("Wolf history location", () => {
  it("uses the CLI's default history location", () => {
    expect(resolveWolfUsageDirectory({})).toBe(
      NodePath.join(NodeOS.homedir(), ".wolf", "agent", "sessions"),
    );
  });
  it("finds sessions under a custom agent home and expands tilde", () => {
    expect(resolveWolfUsageDirectory({ WOLF_CODING_AGENT_DIR: "~/wolf-work" })).toBe(
      NodePath.join(NodeOS.homedir(), "wolf-work", "sessions"),
    );
  });
  it("gives an explicit session directory precedence without appending sessions", () => {
    expect(
      resolveWolfUsageDirectory({
        WOLF_CODING_AGENT_DIR: "~/wolf-work",
        WOLF_CODING_AGENT_SESSION_DIR: "~/history",
      }),
    ).toBe(NodePath.join(NodeOS.homedir(), "history"));
  });
  it("ignores empty overrides and the unsupported WOLF_AGENT_DIR variable", () => {
    expect(
      resolveWolfUsageDirectory({
        WOLF_CODING_AGENT_DIR: " ",
        WOLF_CODING_AGENT_SESSION_DIR: "",
        WOLF_AGENT_DIR: "~/wrong",
      }),
    ).toBe(resolveWolfUsageDirectory({}));
  });
});
