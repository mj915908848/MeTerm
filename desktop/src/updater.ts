import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createUtilityWindow } from './window-utils';
import { t } from './i18n';
import { showToast } from './notify';

// Where every "Check for Updates" entry sends the user. This fork has no
// updater service of its own — the upstream endpoint and its minisign public
// key were removed from tauri.conf.json — so updating is a deliberate manual
// download from our own Releases page rather than a silent in-app install.
const RELEASES_URL = 'https://github.com/mj915908848/MeTerm/releases';

// ── Update state (module-level) ───────────────────────────────────────────────
// Exposed so main.ts can read it for the title bar icon.
export let pendingUpdateVersion: string | null = null;
export let pendingUpdateBody: string | null = null;

// Notify Rust to update the tray/menu-bar "Check for Updates" badge.
async function notifyMenuBadge(version: string | null): Promise<void> {
  try {
    await invoke('set_update_badge', { version });
  } catch {
    // Non-critical — ignore silently.
  }
}

// Open the dedicated updater window (single-instance).
export async function openUpdaterWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('updater');
  if (existing) {
    void existing.show();
    void existing.setFocus();
    return;
  }

  try {
    await createUtilityWindow({
      label: 'updater',
      url: '?window=updater',
      title: t('checkUpdates'),
      width: 500,
      height: 300,
      resizable: false,
    });
    const win = await WebviewWindow.getByLabel('updater');
    if (win) {
      setTimeout(async () => {
        const w = await WebviewWindow.getByLabel('updater');
        if (w) void w.show().then(() => w.setFocus());
      }, 150);
    }
  } catch (e) {
    console.error('Failed to create updater window:', e);
  }
}

// Open the fork's Releases page. Triggered by every "Check for Updates" entry:
// the macOS app menu item, the tray item, and the About tab button.
// The app itself makes no network request and installs nothing by itself.
export function checkUpdateNow(): void {
  void openUrl(RELEASES_URL);
}

// ── In-app toast notification ─────────────────────────────────────────────────

function showUpdateToast(version: string, body: string | null): void {
  const title = t('updateAvailable').replace('{version}', version);
  // Truncate changelog body to ~120 chars for the toast
  let bodyText = '';
  if (body) {
    // Strip markdown symbols for plain-text preview
    const plain = body.replace(/^#{1,3}\s+/gm, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
    bodyText = plain.length > 120 ? plain.slice(0, 117) + '...' : plain;
  }
  showToast({
    title,
    body: bodyText || t('updateNow'),
    duration: 10000,
    onClick: () => { void openUpdaterWindow(); },
  });
}
