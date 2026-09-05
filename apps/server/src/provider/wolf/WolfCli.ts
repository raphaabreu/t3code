/**
 * Wolf CLI conventions shared by the adapter, provider snapshot, and text
 * generation: binary resolution and session-id derivation.
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
