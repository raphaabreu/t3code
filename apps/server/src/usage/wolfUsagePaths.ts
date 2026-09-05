// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expandHomePath } from "../pathExpansion.ts";

/** Matches Wolf's CLI environment overrides, in session-directory priority order. */
export function resolveWolfUsageDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const sessionDir = environment["WOLF_CODING_AGENT_SESSION_DIR"]?.trim();
  if (sessionDir) return NodePath.resolve(expandHomePath(sessionDir));
  const agentDir = environment["WOLF_CODING_AGENT_DIR"]?.trim();
  return NodePath.join(
    agentDir
      ? NodePath.resolve(expandHomePath(agentDir))
      : NodePath.join(NodeOS.homedir(), ".wolf", "agent"),
    "sessions",
  );
}
