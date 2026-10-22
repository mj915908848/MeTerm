import { escapeHtml } from './status-bar';
import { loadSettings, updateSettings } from './themes';
import { t } from './i18n';
import { permissionModeIcon } from './ai-icons';
import { effectivePermissionMode, PERMISSION_MODES } from './ai-permission-rules';
import { permissionModeLabel } from './ai-permission-labels';
import type { AICapsuleInstance } from './ai-capsule-types';

/**
 * The permission-mode quick switcher in the AI bar. It edits the same
 * setting as the mode select in Settings › AI, so the two never disagree.
 */
export function createTrustSwitcher(
  capsules: Map<string, AICapsuleInstance>,
  appendSystemNotice: (inst: AICapsuleInstance, text: string) => void,
): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'ai-bar-trust-switcher';

  const btn = document.createElement('button');
  btn.className = 'ai-bar-btn ai-bar-btn-trust';

  const dropdown = document.createElement('div');
  dropdown.className = 'ai-trust-dropdown';
  dropdown.style.display = 'none';

  const syncButton = () => {
    const mode = effectivePermissionMode(loadSettings());
    btn.innerHTML = permissionModeIcon(mode, 16);
    btn.title = `${t('aiPermissionMode')}: ${permissionModeLabel(mode)}`;
    btn.dataset.mode = mode;
  };

  const close = () => {
    dropdown.style.display = 'none';
    wrapper.classList.remove('open');
  };

  const buildDropdown = () => {
    const currentMode = effectivePermissionMode(loadSettings());
    dropdown.innerHTML = '';
    for (const mode of PERMISSION_MODES) {
      const item = document.createElement('div');
      item.className = `ai-trust-item ${mode === currentMode ? 'active' : ''}`;
      item.innerHTML = `${permissionModeIcon(mode, 14)} <span>${escapeHtml(permissionModeLabel(mode))}</span>`;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        updateSettings({ aiPermissionMode: mode });
        syncButton();
        close();
        const notice = `── ${t('aiPermissionModeChanged').replace('{mode}', permissionModeLabel(mode))} ──`;
        for (const [, inst] of capsules) appendSystemNotice(inst, notice);
      });
      dropdown.appendChild(item);
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dropdown.style.display !== 'none') {
      close();
    } else {
      syncButton();
      buildDropdown();
      dropdown.style.display = '';
      wrapper.classList.add('open');
    }
  });

  document.addEventListener('click', close);
  // The mode can also change in the settings window; pick it up when the
  // user comes back to this one.
  const onFocus = () => {
    if (!wrapper.isConnected) { window.removeEventListener('focus', onFocus); return; }
    syncButton();
  };
  window.addEventListener('focus', onFocus);

  syncButton();
  wrapper.appendChild(btn);
  wrapper.appendChild(dropdown);
  return wrapper;
}
