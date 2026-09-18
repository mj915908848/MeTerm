export type SshTabTitleMode = 'connection' | 'terminal';

/**
 * Resolve the visible title without overwriting the remote terminal title.
 *
 * Only an explicit `'connection'` opts in to name-based titles; a missing or
 * unknown mode keeps the dynamic title so an unset preference can never change
 * what the tab displays.
 */
export function resolveSshTabTitle(
  dynamicTitle: string,
  config: { name?: string; host: string } | undefined,
  mode: SshTabTitleMode | undefined,
): string {
  if (!config || mode !== 'connection') return dynamicTitle;
  return config.name?.trim() || config.host;
}
