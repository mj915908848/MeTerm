/**
 * connection-sidebar.ts — "New connection" actions.
 *
 * The docked connection sidebar that used to live here is gone: clicking the
 * toolbar's connection button now opens a dedicated window (see
 * connections-window.ts), leaving the left dock to the server-info panel. What
 * remains here is the shared "new connection" button grid, used by the home view
 * and — through runNewConnectionAction() — by the connections window, which
 * delegates the actual work back to the main window over a Tauri event.
 */
import { t } from './i18n';
import { icon } from './icons';
import { showSSHModal } from './ssh';

export type NewConnectionKind = 'local' | 'ssh' | 'remote' | 'jumpserver' | 'phone';

export interface NewAction {
  kind: NewConnectionKind;
  iconName: 'terminal' | 'ssh' | 'remote' | 'jumpserver' | 'phone';
  labelKey: 'homeNewLocalSession' | 'homeNewSSHSession' | 'homeRemoteConnect' | 'homeNewJumpServer' | 'homeNewPhonePairing';
  cls: string;
  action: () => void;
  ctxMenu?: boolean;
}

/**
 * Every "new connection" entry, in reading order. Exported so the full-page
 * home can render them as its 2×2 grid without keeping a second copy of the
 * icons, labels and actions — see home-action-grid.ts for the placement.
 */
export const NEW_ACTIONS: NewAction[] = [
  { kind: 'local', iconName: 'terminal', labelKey: 'homeNewLocalSession', cls: 'local', ctxMenu: true, action: () => document.dispatchEvent(new CustomEvent('new-local-session')) },
  { kind: 'ssh', iconName: 'ssh', labelKey: 'homeNewSSHSession', cls: 'ssh', action: () => showSSHModal() },
  { kind: 'remote', iconName: 'remote', labelKey: 'homeRemoteConnect', cls: 'remote', action: () => document.dispatchEvent(new CustomEvent('remote-connect-request')) },
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
  {
    kind: 'phone', iconName: 'phone', labelKey: 'homeNewPhonePairing', cls: 'phone',
    action: async () => {
      const { showPairingDialog } = await import('./pairing');
      await showPairingDialog();
    },
  },
];

/**
 * Run a "new connection" action in this window. The connections window has no
 * terminal of its own, so it forwards the kind here and the main window runs it.
 */
export function runNewConnectionAction(kind: NewConnectionKind): void {
  NEW_ACTIONS.find((a) => a.kind === kind)?.action();
}

/**
 * Build the "new connection" button grid — 5 buttons, 2 per row.
 *
 * `onPick` diverts clicks to the caller (the connections window forwards them to
 * the main window); without it each button runs its own action locally.
 */
export function makeNewButtons(onPick?: (kind: NewConnectionKind) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'home-side-new';
  for (const a of NEW_ACTIONS) {
    const btn = document.createElement('button');
    btn.className = `home-new-btn home-new-${a.cls}`;
    btn.type = 'button';
    btn.dataset.kind = a.kind;
    btn.innerHTML = `<span class="hnb-icon">${icon(a.iconName)}</span><span class="hnb-label">${t(a.labelKey)}</span>`;
    btn.onclick = () => (onPick ? onPick(a.kind) : a.action());
    if (a.ctxMenu && !onPick) {
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('new-local-session-menu', { detail: { mouseEvent: e, anchor: btn } }));
      });
    }
    row.appendChild(btn);
  }
  return row;
}
