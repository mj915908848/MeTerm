import { AppSettings } from './themes';
import { t } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { PROVIDER_PRESETS, fetchModels, type ProviderType, type AIProviderEntry } from './ai-provider';
import { flushSettingsSecrets } from './settings-secrets';
import { createSettingsSelect } from './custom-select';
import { THINKING_BUDGET_TIERS } from './ai-thinking-budget';
import { createGroup, createPage } from './settings-layout';
import {
  createPermissionModeRow,
  createPermissionRulesEditor,
  createAuditLogRow,
  settingLabel,
} from './settings-ai-permission';

const EYE_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.5"/></svg>`;
const CLOSE_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;

/**
 * Settings › AI. Four groups — model services, replies, agent, web search.
 * The rarely touched sampling and context knobs fold away under Advanced at
 * the end of Replies.
 */
export function createAIPage(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement {
  return createPage(t('settingsTabAI'), [
    createGroup(t('aiGroupProviders'), [createProviderList(current, update)]),
    createGroup(t('aiGroupReply'), [...createReplyRows(current, update), ...createAdvancedRows(current, update)]),
    createGroup(t('aiGroupAgent'), createAgentRows(current, update)),
    createGroup(t('aiGroupWebSearch'), createWebSearchRows(current, update)),
  ]);
}

function stopKeyPropagation(el: HTMLInputElement | HTMLSelectElement): void {
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
  el.addEventListener('keypress', (e) => e.stopPropagation());
}

/** A card row: name (with optional hint) on the left, `control` on the right. */
function settingRow(text: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'settings-section';
  row.appendChild(settingLabel(text, hint));
  row.appendChild(control);
  return row;
}

/** A card row ending in a switch. */
function switchRow(id: string, text: string, checked: boolean, onChange: (on: boolean) => void, hint?: string): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'settings-switch-row';
  const label = settingLabel(text, hint);
  const span = document.createElement('span');
  span.className = 'settings-switch-text';
  span.append(...label.childNodes);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  row.append(span, input);
  return row;
}

/** A slider row whose current value is shown after its name. */
function mkSliderRow(
  label: string, id: string, min: number, max: number, step: number, value: number,
  fmt: (v: number) => string, onChange: (v: number) => void, hint?: string,
): HTMLDivElement {
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'settings-slider';
  slider.id = id;
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  const row = settingRow(label, slider, hint);
  const valSpan = document.createElement('span');
  valSpan.className = 'ai-slider-value';
  valSpan.textContent = fmt(value);
  const name = row.querySelector('label')!;
  name.insertBefore(valSpan, name.firstChild!.nextSibling);
  name.insertBefore(document.createTextNode(': '), valSpan);
  slider.oninput = () => {
    const v = parseFloat(slider.value);
    valSpan.textContent = fmt(v);
    onChange(v);
  };
  return row;
}

// ─── Model services ────────────────────────────────────────

function createProviderList(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'ai-provider-list';
  // Providers are listed collapsed; only the ones being edited show their form.
  const expanded = new Set<string>();

  function summaryText(entry: AIProviderEntry): string {
    const key = entry.hasApiKey || entry.apiKey ? t('aiProviderKeySaved') : t('aiProviderNoKey');
    const models = entry.enabledModels.length > 0
      ? t('aiProviderModelsEnabled').replace('{count}', String(entry.enabledModels.length))
      : t('aiProviderNoModelsEnabled');
    return `${key} · ${models}`;
  }

  function render(): void {
    wrap.innerHTML = '';
    const providers = current.aiProviders;
    providers.forEach((entry, idx) => wrap.appendChild(renderProvider(providers, entry, idx)));
    wrap.appendChild(renderAddRow());
  }

  function renderProvider(providers: AIProviderEntry[], entry: AIProviderEntry, idx: number): HTMLDivElement {
    const isOpen = expanded.has(entry.id);
    const item = document.createElement('div');
    item.className = 'ai-provider-item' + (isOpen ? ' open' : '');

    // Summary line: status dot, name, key/model state, edit toggle.
    const summary = document.createElement('div');
    summary.className = 'ai-provider-summary';
    const dot = document.createElement('span');
    dot.className = 'ai-provider-dot' + (entry.enabledModels.length > 0 ? ' ready' : '');
    const text = document.createElement('div');
    text.className = 'ai-provider-summary-text';
    const name = document.createElement('span');
    name.className = 'ai-provider-name';
    name.textContent = entry.label;
    const state = document.createElement('small');
    state.className = 'settings-row-hint';
    state.textContent = summaryText(entry);
    text.append(name, state);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'settings-select settings-test-btn';
    toggle.textContent = isOpen ? t('aiProviderDone') : t('aiProviderEdit');
    toggle.onclick = () => {
      if (isOpen) expanded.delete(entry.id); else expanded.add(entry.id);
      render();
    };
    summary.append(dot, text);
    if (isOpen && providers.length > 1) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'ai-provider-delete-btn';
      deleteBtn.innerHTML = CLOSE_ICON;
      deleteBtn.title = t('aiDeleteProvider');
      deleteBtn.onclick = () => {
        providers.splice(idx, 1);
        expanded.delete(entry.id);
        update({ aiProviders: [...providers] });
        render();
      };
      summary.appendChild(deleteBtn);
    }
    summary.appendChild(toggle);
    item.appendChild(summary);
    if (isOpen) item.appendChild(renderProviderForm(providers, entry, state));
    return item;
  }

  function renderProviderForm(providers: AIProviderEntry[], entry: AIProviderEntry, state: HTMLElement): HTMLDivElement {
    const body = document.createElement('div');
    body.className = 'ai-provider-card-body';
    const commit = () => {
      update({ aiProviders: [...providers] });
      state.textContent = summaryText(entry);
    };

    // Name
    const nameRow = document.createElement('div');
    nameRow.className = 'ai-provider-row ai-row-inline';
    nameRow.innerHTML = `<label>${t('aiProviderLabel')}</label>`;
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'settings-input';
    labelInput.value = entry.label;
    stopKeyPropagation(labelInput);
    labelInput.onchange = () => {
      entry.label = labelInput.value.trim() || entry.label;
      update({ aiProviders: [...providers] });
      render();
    };
    nameRow.appendChild(labelInput);
    body.appendChild(nameRow);

    // Protocol + Base URL
    const protoUrlRow = document.createElement('div');
    protoUrlRow.className = 'ai-provider-row ai-row-inline';
    protoUrlRow.innerHTML = `<label>${t('aiBaseUrl')}</label>`;
    const protoSelect = createSettingsSelect([
      { value: 'openai', label: 'OpenAI', selected: entry.type === 'openai' },
      { value: 'anthropic', label: 'Anthropic', selected: entry.type === 'anthropic' },
      { value: 'gemini', label: 'Gemini', selected: entry.type === 'gemini' },
    ]);
    protoSelect.el.style.width = 'auto';
    protoSelect.el.style.flex = 'none';
    protoSelect.onchange = () => {
      entry.type = protoSelect.value as ProviderType;
      entry.models = [];
      entry.enabledModels = [];
      update({ aiProviders: [...providers] });
      render();
    };
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'settings-input';
    urlInput.style.flex = '1';
    urlInput.value = entry.baseUrl;
    urlInput.placeholder = 'https://api.openai.com';
    stopKeyPropagation(urlInput);
    urlInput.onchange = () => {
      entry.baseUrl = urlInput.value.trim();
      update({ aiProviders: [...providers] });
    };
    protoUrlRow.appendChild(protoSelect.el);
    protoUrlRow.appendChild(urlInput);
    body.appendChild(protoUrlRow);

    // API Key + Fetch Models
    const keyFetchRow = document.createElement('div');
    keyFetchRow.className = 'ai-provider-row ai-row-inline';
    keyFetchRow.innerHTML = `<label>${t('aiApiKey')}</label>`;
    const keyGroup = document.createElement('div');
    keyGroup.className = 'settings-input-group';
    keyGroup.style.flex = '1';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.className = 'settings-input';
    keyInput.style.flex = '1';
    keyInput.value = '';
    keyInput.placeholder = entry.hasApiKey
      ? (current.language === 'zh' ? 'API Key（已保存，输入新值替换）' : 'API Key (saved; enter to replace)')
      : 'API Key';
    stopKeyPropagation(keyInput);
    keyInput.onchange = () => {
      entry.apiKey = keyInput.value.trim();
      entry.clearApiKey = false;
      commit();
    };
    const keyToggle = document.createElement('button');
    keyToggle.className = 'settings-toggle-btn';
    keyToggle.title = 'Show/Hide';
    keyToggle.innerHTML = EYE_ICON;
    keyToggle.onclick = () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; };
    keyGroup.appendChild(keyInput);
    keyGroup.appendChild(keyToggle);
    if (entry.hasApiKey) {
      const clearKeyBtn = document.createElement('button');
      clearKeyBtn.className = 'settings-toggle-btn';
      clearKeyBtn.textContent = '×';
      clearKeyBtn.title = current.language === 'zh' ? '删除已保存的 API Key' : 'Delete saved API Key';
      clearKeyBtn.onclick = () => {
        entry.apiKey = '';
        entry.hasApiKey = false;
        entry.clearApiKey = true;
        keyInput.value = '';
        update({ aiProviders: [...providers] });
        render();
      };
      keyGroup.appendChild(clearKeyBtn);
    }
    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'settings-select settings-test-btn';
    fetchBtn.textContent = t('aiFetchModels');
    const fetchStatus = document.createElement('span');
    fetchStatus.className = 'settings-test-result';
    if (entry.models.length > 0) {
      fetchStatus.textContent = `${entry.models.length} ${t('aiModelsCount')}`;
      fetchStatus.className = 'settings-test-result test-success';
    }
    fetchBtn.onclick = async () => {
      entry.apiKey = keyInput.value.trim();
      entry.clearApiKey = false;
      entry.baseUrl = urlInput.value.trim();
      fetchBtn.disabled = true;
      fetchStatus.textContent = t('aiFetching');
      fetchStatus.className = 'settings-test-result';
      try {
        // Persist a newly typed replacement before asking the opaque broker
        // to use it. Existing saved keys never enter this input.
        update({ aiProviders: [...providers] });
        await flushSettingsSecrets();
        const models = await fetchModels(entry);
        entry.models = models;
        entry.enabledModels = entry.enabledModels.filter((m) => models.includes(m));
        commit();
        fetchStatus.textContent = `${models.length} ${t('aiFetchSuccess')}`;
        fetchStatus.className = 'settings-test-result test-success';
        renderModelCheckboxes();
      } catch (e) {
        fetchStatus.textContent = `${t('aiFetchFailed')}: ${(e as Error).message}`;
        fetchStatus.className = 'settings-test-result test-failed';
      }
      fetchBtn.disabled = false;
    };
    keyFetchRow.appendChild(keyGroup);
    keyFetchRow.appendChild(fetchBtn);
    body.appendChild(keyFetchRow);
    const statusRow = document.createElement('div');
    statusRow.className = 'ai-provider-row';
    statusRow.appendChild(fetchStatus);
    body.appendChild(statusRow);

    // Model checkboxes
    const modelArea = document.createElement('div');
    modelArea.className = 'ai-provider-models';

    function renderModelCheckboxes(): void {
      modelArea.innerHTML = '';
      if (entry.models.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'ai-provider-models-hint';
        hint.textContent = t('aiNoModels');
        modelArea.appendChild(hint);
        return;
      }

      const modelsLabel = document.createElement('label');
      modelsLabel.className = 'ai-provider-models-label';
      modelsLabel.textContent = t('aiSelectModels');
      modelArea.appendChild(modelsLabel);

      const grid = document.createElement('div');
      grid.className = 'ai-provider-models-grid';
      for (const model of entry.models) {
        const label = document.createElement('label');
        label.className = 'ai-model-checkbox';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = entry.enabledModels.includes(model);
        cb.onchange = () => {
          if (cb.checked) {
            if (!entry.enabledModels.includes(model)) entry.enabledModels.push(model);
          } else {
            entry.enabledModels = entry.enabledModels.filter((m) => m !== model);
          }
          commit();
        };
        const span = document.createElement('span');
        span.textContent = model;
        span.title = model;
        label.appendChild(cb);
        label.appendChild(span);
        grid.appendChild(label);
      }
      modelArea.appendChild(grid);
    }
    renderModelCheckboxes();
    body.appendChild(modelArea);
    return body;
  }

  function renderAddRow(): HTMLDivElement {
    const addRow = document.createElement('div');
    addRow.className = 'ai-add-provider-section';
    addRow.innerHTML = `<label>${t('aiAddProvider')}</label>`;
    const buttons = document.createElement('div');
    buttons.className = 'settings-preset-buttons';
    const presets = [...PROVIDER_PRESETS, { id: 'custom', label: t('aiCustomProvider'), type: 'openai' as ProviderType, baseUrl: '', model: '' }];
    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.className = 'settings-preset-btn';
      btn.textContent = `+ ${preset.label}`;
      btn.addEventListener('click', () => {
        const newEntry: AIProviderEntry = {
          id: `${preset.id}-${Date.now().toString(36)}`,
          type: preset.type,
          label: preset.label,
          apiKey: '',
          hasApiKey: false,
          baseUrl: preset.baseUrl,
          models: [],
          enabledModels: [],
        };
        current.aiProviders.push(newEntry);
        expanded.add(newEntry.id);
        update({ aiProviders: [...current.aiProviders] });
        render();
      });
      buttons.appendChild(btn);
    }
    addRow.appendChild(buttons);
    return addRow;
  }

  render();
  return wrap;
}

// ─── Replies ───────────────────────────────────────────────

function createReplyRows(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement[] {
  const maxTokensRow = mkSliderRow(t('aiMaxTokens'), 'ai-tokens-slider', 256, 16384, 256, current.aiMaxTokens,
    (v) => `${v}`, (v) => update({ aiMaxTokens: v }), t('aiMaxTokensHint'));

  // Reasoning-token cap, paired with the thinking toggle. Sent as a
  // top-level `thinking_budget` field; "Model default" (0) sends nothing
  // so the provider keeps its own value.
  const thinkBudgetSel = createSettingsSelect(
    THINKING_BUDGET_TIERS.map((tier) => ({
      value: String(tier.value),
      label: t(tier.labelKey),
      selected: current.aiThinkingBudget === tier.value,
    })),
  );
  thinkBudgetSel.onchange = () => update({ aiThinkingBudget: Number(thinkBudgetSel.value) });
  const thinkBudgetRow = settingRow(t('aiThinkingBudget'), thinkBudgetSel.el, t('aiThinkingBudgetHint'));
  thinkBudgetRow.classList.toggle('settings-row-disabled', !current.aiEnableThinking);

  // Thinking mode only reaches OpenAI-compatible third parties
  // (DeepSeek, Qwen, GLM, MiMo); the hint says so.
  const thinkRow = switchRow('ai-enable-thinking', t('aiEnableThinking'), current.aiEnableThinking, (on) => {
    update({ aiEnableThinking: on });
    thinkBudgetRow.classList.toggle('settings-row-disabled', !on);
  }, t('aiEnableThinkingHint'));

  return [maxTokensRow, thinkRow, thinkBudgetRow];
}

// ─── Agent ─────────────────────────────────────────────────

function createAgentRows(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement[] {
  // Max steps slider + Unlimited checkbox
  const isUnlimited = current.aiAgentMaxIterations === 0;
  const iterRow = mkSliderRow(t('aiAgentMaxIterations'), 'ai-iter-slider', 1, 60, 1,
    isUnlimited ? 30 : current.aiAgentMaxIterations,
    (v) => `${v}`, (v) => update({ aiAgentMaxIterations: v }));
  const iterSlider = iterRow.querySelector('#ai-iter-slider') as HTMLInputElement;
  const iterValSpan = iterRow.querySelector('.ai-slider-value') as HTMLSpanElement;

  const iterControl = document.createElement('div');
  iterControl.className = 'ai-iter-control';
  iterSlider.replaceWith(iterControl);
  iterControl.appendChild(iterSlider);
  const unlimitedLabel = document.createElement('label');
  unlimitedLabel.className = 'ai-unlimited-label';
  unlimitedLabel.innerHTML = `<input type="checkbox" id="ai-iter-unlimited" ${isUnlimited ? 'checked' : ''}> ${t('aiAgentUnlimited')}`;
  iterControl.appendChild(unlimitedLabel);

  const unlimitedCb = unlimitedLabel.querySelector('#ai-iter-unlimited') as HTMLInputElement;
  if (isUnlimited) {
    iterSlider.disabled = true;
    iterValSpan.textContent = '∞';
  }
  unlimitedCb.onchange = () => {
    if (unlimitedCb.checked) {
      iterSlider.disabled = true;
      iterValSpan.textContent = '∞';
      update({ aiAgentMaxIterations: 0 });
    } else {
      iterSlider.disabled = false;
      const v = parseFloat(iterSlider.value);
      iterValSpan.textContent = `${v}`;
      update({ aiAgentMaxIterations: v });
    }
  };

  return [
    createPermissionModeRow(current, update),
    createPermissionRulesEditor(current, update),
    iterRow,
    createAuditLogRow(),
  ];
}

// ─── Web search (SearXNG) ──────────────────────────────────

function createWebSearchRows(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement[] {
  const enableRow = switchRow('searxng-enable', t('aiSearxngEnable'), current.searxngEnabled,
    (on) => update({ searxngEnabled: on }), t('aiSearxngEnableHint'));

  const searxUrlInput = document.createElement('input');
  searxUrlInput.type = 'text';
  searxUrlInput.className = 'settings-input';
  searxUrlInput.value = current.searxngUrl;
  searxUrlInput.placeholder = t('aiSearxngUrlPlaceholder');
  stopKeyPropagation(searxUrlInput);
  searxUrlInput.addEventListener('change', () => {
    let val = searxUrlInput.value.trim();
    if (val.endsWith('/')) val = val.slice(0, -1);
    searxUrlInput.value = val;
    update({ searxngUrl: val });
  });
  const urlRow = settingRow(t('aiSearxngUrl'), searxUrlInput);

  // Auth: user + pass + eye (+ clear when a password is saved)
  const searxAuthGroup = document.createElement('div');
  searxAuthGroup.className = 'settings-input-group';
  searxAuthGroup.style.minWidth = '0';
  const searxUserInput = document.createElement('input');
  searxUserInput.type = 'text';
  searxUserInput.className = 'settings-input';
  searxUserInput.style.flex = '1';
  searxUserInput.style.minWidth = '0';
  searxUserInput.value = current.searxngUsername;
  searxUserInput.placeholder = t('aiSearxngUsername');
  searxUserInput.autocomplete = 'off';
  stopKeyPropagation(searxUserInput);
  searxUserInput.addEventListener('change', () => update({ searxngUsername: searxUserInput.value.trim() }));
  const searxPassInput = document.createElement('input');
  searxPassInput.type = 'password';
  searxPassInput.className = 'settings-input';
  searxPassInput.style.flex = '1';
  searxPassInput.style.minWidth = '0';
  searxPassInput.value = '';
  searxPassInput.placeholder = current.searxngHasPassword
    ? (current.language === 'zh' ? '密码已保存，输入新值替换' : 'Password saved; enter to replace')
    : t('aiSearxngPassword');
  searxPassInput.autocomplete = 'off';
  stopKeyPropagation(searxPassInput);
  searxPassInput.addEventListener('change', () => update({
    searxngPassword: searxPassInput.value,
    searxngClearPassword: false,
  }));
  const searxPassToggle = document.createElement('button');
  searxPassToggle.className = 'settings-toggle-btn';
  searxPassToggle.title = 'Show/Hide';
  searxPassToggle.innerHTML = EYE_ICON;
  searxPassToggle.onclick = () => { searxPassInput.type = searxPassInput.type === 'password' ? 'text' : 'password'; };
  searxAuthGroup.appendChild(searxUserInput);
  searxAuthGroup.appendChild(searxPassInput);
  searxAuthGroup.appendChild(searxPassToggle);
  if (current.searxngHasPassword) {
    const clearSearxPassword = document.createElement('button');
    clearSearxPassword.className = 'settings-toggle-btn';
    clearSearxPassword.textContent = '×';
    clearSearxPassword.title = current.language === 'zh' ? '删除已保存的密码' : 'Delete saved password';
    clearSearxPassword.onclick = () => {
      searxPassInput.value = '';
      update({
        searxngPassword: '',
        searxngHasPassword: false,
        searxngClearPassword: true,
      });
    };
    searxAuthGroup.appendChild(clearSearxPassword);
  }
  const authRow = settingRow(t('aiSearxngAuth'), searxAuthGroup);

  // Test: result on the left, button on the right
  const searxTestBtn = document.createElement('button');
  searxTestBtn.className = 'settings-select settings-test-btn';
  searxTestBtn.style.justifySelf = 'end';
  searxTestBtn.textContent = t('aiSearxngTest');
  const testRow = document.createElement('div');
  testRow.className = 'settings-section';
  const searxTestStatus = document.createElement('label');
  searxTestStatus.className = 'settings-test-result';
  testRow.append(searxTestStatus, searxTestBtn);
  const setStatus = (text: string, cls = '') => {
    searxTestStatus.textContent = text;
    searxTestStatus.className = `settings-test-result ${cls}`.trim();
  };
  searxTestBtn.addEventListener('click', async () => {
    const url = searxUrlInput.value.trim().replace(/\/+$/, '');
    if (!url) return;
    searxTestBtn.disabled = true;
    setStatus(t('aiTesting'));
    try {
      const user = searxUserInput.value.trim();
      const pass = searxPassInput.value;
      update({
        searxngUrl: url,
        searxngUsername: user,
        ...(pass ? { searxngPassword: pass, searxngClearPassword: false } : {}),
      });
      await flushSettingsSecrets();
      const resp = await invoke<{ ok: boolean; status: number; body: string }>('fetch_searxng_search', {
        request: { baseUrl: url, username: user, query: 'test', page: 1 },
      });
      if (!resp.ok) {
        setStatus(`${t('aiSearxngTestFail')} (HTTP ${resp.status})`, 'test-failed');
        searxTestBtn.disabled = false;
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(resp.body);
      } catch {
        // Response is not JSON — SearXNG may not have JSON format enabled
        const isHtml = resp.body.trimStart().startsWith('<');
        setStatus(isHtml
          ? `${t('aiSearxngTestFail')}: JSON API not enabled in SearXNG settings.yml (search.formats)`
          : `${t('aiSearxngTestFail')}: invalid JSON response`, 'test-failed');
        searxTestBtn.disabled = false;
        return;
      }
      if (data.results !== undefined) {
        setStatus(t('aiSearxngTestOk'), 'test-success');
      } else {
        setStatus(`${t('aiSearxngTestFail')}: response missing "results" field`, 'test-failed');
      }
    } catch (e) {
      setStatus(`${t('aiSearxngTestFail')}: ${e instanceof Error ? e.message : String(e)}`, 'test-failed');
    }
    searxTestBtn.disabled = false;
  });

  return [enableRow, urlRow, authRow, testRow];
}

// ─── Advanced (folded into Replies) ────────────────────────

/** Survives panel rebuilds, so an outside settings change keeps it open. */
let advancedOpen = false;

function createAdvancedRows(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement[] {
  const rows = [
    mkSliderRow(t('aiTemperature'), 'ai-temp-slider', 0, 20, 1, Math.round(current.aiTemperature * 10),
      (v) => (v / 10).toFixed(1), (v) => update({ aiTemperature: v / 10 }), t('aiTemperatureHint')),
    // Input side of the context split: how much conversation history to
    // carry before compaction. Paired with aiMaxTokens (the output
    // reservation) — both feed shouldAutoCompact. Step is 32k, so the
    // default 128k sits exactly 4 steps up from the floor.
    mkSliderRow(t('aiHistoryBudget'), 'ai-history-budget-slider', 32 * 1024, 1024 * 1024, 32 * 1024, current.aiHistoryBudgetTokens,
      (v) => `${Math.round(v / 1024)}k`, (v) => update({ aiHistoryBudgetTokens: v }), t('aiHistoryBudgetHint')),
    mkSliderRow(t('aiContextLines'), 'ai-context-slider', 10, 200, 10, current.aiContextLines,
      (v) => `${v}`, (v) => update({ aiContextLines: v }), t('aiContextLinesHint')),
  ];
  for (const row of rows) row.classList.add('ai-advanced-row');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ai-advanced-toggle';
  toggle.innerHTML = `<span class="ai-advanced-chevron" aria-hidden="true"></span><span></span><small class="settings-row-hint"></small>`;
  toggle.children[1].textContent = t('aiGroupAdvanced');
  toggle.children[2].textContent = t('aiAdvancedSummary');
  // Rows stay in the card so settings search can still reach them; CSS
  // hides them while the toggle says it is folded.
  toggle.setAttribute('aria-expanded', String(advancedOpen));
  toggle.onclick = () => {
    advancedOpen = !advancedOpen;
    toggle.setAttribute('aria-expanded', String(advancedOpen));
  };
  return [toggle, ...rows];
}
