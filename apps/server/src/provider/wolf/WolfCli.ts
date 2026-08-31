/**
 * Wolf CLI conventions shared by the adapter, provider snapshot, and text
 * generation: binary resolution, session-id derivation, and the on-disk
 * locations Wolf writes.
 *
 * @module provider/wolf/WolfCli
 */
export const WOLF_DEFAULT_BINARY = "wolf";

export function resolveWolfBinary(settings: { readonly binaryPath?: string | undefined }): string {
  const configured = settings.binaryPath?.trim();
  return configured && configured.length > 0 ? configured : WOLF_DEFAULT_BINARY;
}

/**
 * Wolf keys sessions by project directory plus session id. Prefixing keeps
 * T3-driven sessions recognizable in `wolf -r` alongside a user's own.
 */
export function wolfSessionIdForThread(threadId: string): string {
  return `t3-${threadId}`;
}

/**
 * Wolf's agent home. Sessions live below `<home>/sessions`, credentials in
 * `<home>/auth.json`. `WOLF_AGENT_DIR` wins when set, matching the CLI.
 */
export function wolfAgentDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env.WOLF_AGENT_DIR?.trim();
  return override && override.length > 0 ? override : `${homeDir}/.wolf/agent`;
}
