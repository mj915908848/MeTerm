import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { homeDir, join } from '@tauri-apps/api/path';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import { open as openFile, stat } from '@tauri-apps/plugin-fs';
import { isWindowsPlatform } from './app-state';
import type { SavedConnection } from './connection-sync';
import { t } from './i18n';
import { MAX_OPENSSH_CONFIG_BYTES, parseOpenSshConfig } from './openssh-config';
import { addConnection, loadSavedConnections } from './ssh';

const PREVIEW_LIMIT = 8;

async function readOpenSshConfig(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile || info.size > MAX_OPENSSH_CONFIG_BYTES) throw new Error('Invalid OpenSSH config file');
  const file = await openFile(path, { read: true });
  try {
    const bytes = new Uint8Array(MAX_OPENSSH_CONFIG_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = await file.read(bytes.subarray(size));
      if (count === null) break;
      size += count;
    }
    if (size === bytes.length) throw new Error('OpenSSH config file is too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    await file.close();
  }
}

export function createOpenSshImportButton(status: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'settings-select';
  button.style.cursor = 'pointer';
  button.textContent = t('sshOpenSshImport');

  function showStatus(message: string, failed = false): void {
    status.textContent = message;
    status.className = `settings-ssh-io-status ${failed ? 'ssh-status-error' : 'ssh-status-success'}`;
  }

  button.onclick = async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      const defaultPath = await homeDir().then(home => join(home, '.ssh')).catch(() => undefined);
      const path = await open({ title: t('sshOpenSshImport'), multiple: false, defaultPath });
      if (typeof path !== 'string') return;
      const parsed = parseOpenSshConfig(await readOpenSshConfig(path), isWindowsPlatform);
      const registered = await invoke<SavedConnection[]>('sync_get_connections');
      const usedNames = new Set([
        ...loadSavedConnections(),
        ...registered.filter(connection => connection.deleted_at === null),
      ].map(connection => connection.name.toLowerCase()));
      const candidates = parsed.connections.filter(connection => !usedNames.has(connection.name.toLowerCase()));
      let skipped = parsed.skipped + parsed.connections.length - candidates.length;
      if (candidates.length === 0) {
        showStatus(t('sshOpenSshNoNewHosts'), true);
        return;
      }

      const preview = candidates.slice(0, PREVIEW_LIMIT).map(({ name, host, port, username }) => {
        const address = host.includes(':') ? `[${host}]` : host;
        return `${name} → ${username}@${address}:${port}`;
      });
      if (candidates.length > PREVIEW_LIMIT) {
        preview.push(t('sshOpenSshPreviewMore').replace('{count}', String(candidates.length - PREVIEW_LIMIT)));
      }
      const summary = t('sshOpenSshPreview')
        .replace('{count}', String(candidates.length)).replace('{skipped}', String(skipped));
      if (!await confirm(`${summary}\n\n${preview.join('\n')}`, { title: t('sshOpenSshImport') })) return;

      let imported = 0;
      let stopped = false;
      for (const connection of candidates) {
        if (loadSavedConnections().some(saved => saved.name.toLowerCase() === connection.name.toLowerCase())) {
          skipped++;
          continue;
        }
        try {
          await addConnection(connection, true);
          imported++;
        } catch {
          stopped = true;
          break;
        }
      }
      if (imported > 0) void emit('ssh-connections-changed').catch(() => {});
      const result = t(stopped ? 'sshOpenSshStopped' : 'sshOpenSshImported')
        .replace('{count}', String(imported)).replace('{skipped}', String(skipped));
      showStatus(result, stopped);
    } catch {
      showStatus(t('sshOpenSshUnreadable'), true);
    } finally {
      button.disabled = false;
    }
  };
  return button;
}
