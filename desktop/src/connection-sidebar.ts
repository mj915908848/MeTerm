/**
 * connection-sidebar.ts — "New connection" actions.
 *
 * The docked connection sidebar that used to live here is gone (the toolbar's
 * connection button now opens the quick switcher, quick-switcher.ts). What
 * remains is the shared list of "new connection" actions, used by the home page
 * and the switcher.
 */
import { showSSHModal } from './ssh';

export type NewConnectionKind = 'local' | 'ssh' | 'jumpserver';

export interface NewAction {
  kind: NewConnectionKind;
  iconName: 'terminal' | 'ssh' | 'jumpserver';
  labelKey: 'homeNewLocalSession' | 'homeNewSSHSession' | 'homeNewJumpServer';
  cls: string;
  action: () => void;
  ctxMenu?: boolean;
}

/**
 * Every "new connection" entry, in reading order. Exported so the home page can
 * render them as its buttons without keeping a second copy of the icons, labels
 * and actions.
 */
export const NEW_ACTIONS: NewAction[] = [
  { kind: 'local', iconName: 'terminal', labelKey: 'homeNewLocalSession', cls: 'local', ctxMenu: true, action: () => document.dispatchEvent(new CustomEvent('new-local-session')) },
  { kind: 'ssh', iconName: 'ssh', labelKey: 'homeNewSSHSession', cls: 'ssh', action: () => showSSHModal() },
  {
    kind: 'jumpserver', iconName: 'jumpserver', labelKey: 'homeNewJumpServer', cls: 'jumpserver',
    action: async () => {
      const { showJumpServerConfigDialog } = await import('./jumpserver-ui');
      const result = await showJumpServerConfigDialog();
      if (result?.connect) {
        const { handleJumpServerConnect } = await import('./jumpserver-handler');
        handleJumpServerConnect(result.config);
      }
    },
  },
];

/** Run a "new connection" action in this window. */
export function runNewConnectionAction(kind: NewConnectionKind): void {
  NEW_ACTIONS.find((a) => a.kind === kind)?.action();
}
