import { escapeHtml } from './status-bar';
import { loadSettings, updateSettings } from './themes';
import { t } from './i18n';
import { permissionModeIcon } from './ai-icons';
import { effectivePermissionMode, PERMISSION_MODES } from './ai-permission-rules';
import { permissionModeLabel } from './ai-permission-labels';
import { SETTINGS_STORAGE_KEY } from './settings-secrets';
import type { AICapsuleInstance } from './ai-capsule-types';

const switchers = new WeakMap<Element, { sync: () => void; close: () => void }>();
let isWatching = false;

function syncSwitchers(): void {
  for (const wrapper of document.querySelectorAll('.ai-bar-trust-switcher')) {
    switchers.get(wrapper)?.sync();
  }
}

function watchSwitchers(): void {
  if (isWatching) return;
  isWatching = true;
  document.addEventListener('click', () => {
    for (const wrapper of document.querySelectorAll('.ai-bar-trust-switcher.open')) {
      switchers.get(wrapper)?.close();
    }
  });
  window.addEventListener('focus', syncSwitchers);
  window.addEventListener('storage', (e) => {
    if (e.key === SETTINGS_STORAGE_KEY) syncSwitchers();
  });
}

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
  btn.type = 'button';
  btn.className = 'ai-bar-btn ai-bar-btn-trust';
  btn.setAttribute('aria-expanded', 'false');

  const dropdown = document.createElement('div');
  dropdown.className = 'ai-trust-dropdown';
  dropdown.style.display = 'none';

  const label = document.createElement('span');
  label.className = 'ai-trust-label';
  const syncButton = () => {
    const mode = effectivePermissionMode(loadSettings());
    label.textContent = permissionModeLabel(mode);
    btn.innerHTML = permissionModeIcon(mode, 16);
    btn.appendChild(label);
    btn.title = `${t('aiPermissionMode')}: ${label.textContent}`;
    btn.setAttribute('aria-label', btn.title);
    btn.dataset.mode = mode;
  };

  const close = () => {
    dropdown.style.display = 'none';
    wrapper.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };

  const buildDropdown = () => {
    const currentMode = effectivePermissionMode(loadSettings());
    dropdown.innerHTML = '';
    for (const mode of PERMISSION_MODES) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `ai-trust-item ${mode === currentMode ? 'active' : ''}`;
      item.setAttribute('aria-pressed', String(mode === currentMode));
      item.innerHTML = `${permissionModeIcon(mode, 14)} <span>${escapeHtml(permissionModeLabel(mode))}</span>`;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        updateSettings({ aiPermissionMode: mode });
        syncSwitchers();
        close();
        btn.focus();
        const notice = t('aiPermissionModeChanged').replace('{mode}', permissionModeLabel(mode));
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
      btn.setAttribute('aria-expanded', 'true');
      dropdown.querySelector<HTMLButtonElement>('.active')?.focus();
    }
  });

  wrapper.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dropdown.style.display === 'none') return;
    e.preventDefault();
    e.stopPropagation();
    close();
    btn.focus();
  });
  wrapper.addEventListener('focusout', (e) => {
    if (e.relatedTarget instanceof Node && !wrapper.contains(e.relatedTarget)) close();
  });
  watchSwitchers();
  switchers.set(wrapper, { sync: syncButton, close });
  syncButton();
  wrapper.appendChild(btn);
  wrapper.appendChild(dropdown);
  return wrapper;
}
