export type SshTabTitleMode = 'connection' | 'terminal';

/** Resolve the visible title without overwriting the remote terminal title. */
export function resolveSshTabTitle(
  dynamicTitle: string,
  config: { name?: string; host: string } | undefined,
  mode: SshTabTitleMode | undefined,
): string {
  if (!config || mode === 'terminal') return dynamicTitle;
  return config.name?.trim() || config.host;
}
