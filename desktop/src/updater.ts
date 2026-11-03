import { check, type Update } from '@tauri-apps/plugin-updater';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getLanguage, t, tf } from './i18n';
import { showToast } from './notify';

// 应用内更新：Tauri updater 读取 GitHub Release 上的 latest.json（由 updater-manifest.yml
// 在两个平台都打包完后生成），下载对应平台的包，用 tauri.conf.json 里的公钥校验签名后安装。
// 检查失败（离线、Release 还没有 latest.json 等）时退回到打开 Releases 页面手动下载。
//
// In-app updates: the Tauri updater reads latest.json from the latest GitHub Release
// (written by updater-manifest.yml once every platform is built), downloads this
// platform's package, verifies it against the pubkey in tauri.conf.json and installs it.
// If checking fails (offline, no latest.json yet, ...) we fall back to the Releases page.
const RELEASES_URL = 'https://github.com/mj915908848/MeTerm/releases';

// Dev builds (`make desktop-dev`) are not an installed bundle, so there is nothing
// for the updater to replace; keep the old "open the Releases page" behaviour there.
const UPDATER_ENABLED = !import.meta.env.DEV;

let busy = false;

/** Manual "Check for Updates" (app menu, tray, About tab). */
export async function checkUpdateNow(): Promise<void> {
  if (!UPDATER_ENABLED) {
    void openUrl(RELEASES_URL);
    return;
  }
  if (busy) return;
  busy = true;
  let update: Update | null;
  try {
    showToast({ title: t('updateChecking'), body: '', duration: 2500 });
    update = await check();
  } catch (err) {
    busy = false;
    console.warn('[updater] check failed:', err);
    await offerReleasesPage(tf('updateCheckFailed', { error: String(err) }));
    return;
  }
  busy = false;
  if (!update) {
    await showMessage(t('updateUpToDate'));
    return;
  }
  await promptAndInstall(update);
}

/**
 * Quiet check once after the main window is ready. Only speaks up when there is
 * a newer version; errors are logged and otherwise ignored.
 */
export function scheduleStartupUpdateCheck(delayMs = 15_000): void {
  if (!UPDATER_ENABLED) return;
  setTimeout(() => {
    if (busy) return;
    void (async () => {
      try {
        const update = await check();
        if (!update) return;
        showToast({
          title: tf('updateAvailable', { version: update.version }),
          body: t('updateClickToInstall'),
          duration: 15_000,
          onClick: () => { void promptAndInstall(update); },
        });
      } catch (err) {
        console.warn('[updater] startup check failed:', err);
      }
    })();
  }, delayMs);
}

async function promptAndInstall(update: Update): Promise<void> {
  if (busy) return;
  const notes = summarizeNotes(update.body ?? '');
  const text = tf('updatePrompt', { version: update.version, current: update.currentVersion })
    + (notes ? `\n\n${notes}` : '');
  let ok = false;
  try {
    ok = await confirm(text, {
      title: t('appName'),
      kind: 'info',
      okLabel: t('updateInstallNow'),
      cancelLabel: t('updateLater'),
    });
  } catch {
    ok = window.confirm(text);
  }
  if (!ok) return;

  busy = true;
  const progress = createProgressToast(tf('updateDownloading', { pct: 0 }));
  let downloaded = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        const pct = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
        progress.set(tf('updateDownloading', { pct }));
      } else if (event.event === 'Finished') {
        progress.set(t('updateInstalling'));
      }
    });
    // Windows: the NSIS installer has already taken over and quit the app by now.
    // macOS: the new bundle is in place; restart into it.
    progress.set(t('updateRestarting'));
    await new Promise((r) => setTimeout(r, 600));
    await invoke('restart_app_via_open');
  } catch (err) {
    busy = false;
    progress.close();
    console.error('[updater] install failed:', err);
    await offerReleasesPage(tf('updateInstallFailed', { error: String(err) }));
  }
}

async function offerReleasesPage(text: string): Promise<void> {
  let open = false;
  try {
    open = await confirm(text, {
      title: t('appName'),
      kind: 'warning',
      okLabel: t('updateOpenReleases'),
      cancelLabel: t('updateCancel'),
    });
  } catch {
    open = window.confirm(text);
  }
  if (open) void openUrl(RELEASES_URL);
}

async function showMessage(text: string): Promise<void> {
  try {
    await message(text, { title: t('appName'), kind: 'info' });
  } catch {
    window.alert(text);
  }
}

/**
 * Release notes come from UPDATE.md: a Chinese section, `---`, then
 * `## Changelog (English)`. Keep the half matching the UI language, strip
 * Markdown and cap the length so it fits a native dialog.
 */
export function summarizeNotes(body: string, lang = getLanguage(), maxLen = 600): string {
  const parts = body.replace(/\r\n/g, '\n').split(/^##\s+Changelog \(English\)\s*$/m);
  let section = (lang === 'en' && parts.length > 1 ? parts[1] : parts[0]) ?? '';
  section = section
    .replace(/^##\s+更新日志.*$/m, '')
    .replace(/^---+\s*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return section.length > maxLen ? `${section.slice(0, maxLen - 1).trimEnd()}…` : section;
}

/** A toast that stays up and whose text can be updated (download progress). */
function createProgressToast(initial: string): { set: (text: string) => void; close: () => void } {
  let container = document.querySelector('.toast-container') as HTMLDivElement | null;
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  const header = document.createElement('div');
  header.className = 'toast-header';
  const title = document.createElement('span');
  title.className = 'toast-title';
  title.textContent = t('updateTitle');
  header.appendChild(title);
  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = initial;
  toast.append(header, body);
  container.appendChild(toast);
  return {
    set: (text) => { body.textContent = text; },
    close: () => { toast.remove(); },
  };
}
