import { AppSettings, ColorScheme, getEffectiveTheme, getThemesForType, loadSettings, type ThemeType } from './themes';
import { getAvailableLanguages, t, setLanguage } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { FONT_REGISTRY, UI_FONT_EXTRAS, getFontDef, getAvailableCJKFonts } from './fonts';
import { isMacPlatform } from './app-state';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { exportConnectionsToFile, formatSSHExportResult, importConnectionsFromJSON } from './ssh';
import { createSettingsSelect } from './custom-select';
import { escapeHtml } from './status-bar';
import { createGroup, createPage, switchRow, SETTINGS_ICONS, type SettingsPage } from './settings-layout';
import { createCommandAssistRows } from './settings-command-assist';
// emit removed — palette now syncs through update() → saveSettings → settings-changed

/**
 * Build every non-AI settings page. Each control is created once below with
 * its handlers; the end of this function only decides where the rows go.
 */
export function createGeneralPages(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
  onLanguageChange: () => void,
): SettingsPage[] {

  /** Put a line of explanation under a row's name. */
  const hint = <T extends HTMLElement | null>(row: T, text: string): T => {
    const target = row?.querySelector('.settings-switch-text') ?? row?.querySelector('label');
    if (target) {
      const small = document.createElement('small');
      small.className = 'settings-row-hint';
      small.textContent = text;
      target.appendChild(small);
    }
    return row;
  };
  const show = (row: HTMLElement | null, on: boolean) => { if (row) row.style.display = on ? '' : 'none'; };

  // --- Language + Color Scheme ---
  const langSection = document.createElement('div');
  langSection.className = 'settings-section';
  langSection.innerHTML = `<label>${t('language')}</label>`;
  const langSelect = createSettingsSelect(
    getAvailableLanguages().map((lang) => ({ value: lang.value, label: lang.label, selected: lang.value === current.language })),
  );
  langSection.appendChild(langSelect.el);
  langSelect.onchange = () => {
    const language = langSelect.value as 'en' | 'zh';
    setLanguage(language);
    update({ language });
    onLanguageChange();
  };

  const colorSchemeSection = document.createElement('div');
  colorSchemeSection.className = 'settings-section';
  colorSchemeSection.innerHTML = `<label>${t('colorScheme')}</label>`;
  const colorSchemeSelect = createSettingsSelect([
    { value: 'auto', label: t('colorSchemeAuto'), selected: current.colorScheme === 'auto' },
    { value: 'dark', label: t('colorSchemeDark'), selected: current.colorScheme === 'dark' },
    { value: 'darker', label: t('colorSchemeDarker'), selected: current.colorScheme === 'darker' },
    { value: 'navy', label: t('colorSchemeNavy'), selected: current.colorScheme === 'navy' },
    { value: 'light', label: t('colorSchemeLight'), selected: current.colorScheme === 'light' },
  ]);
  colorSchemeSection.appendChild(colorSchemeSelect.el);

  // --- Terminal Theme: one per appearance, so switching appearance never
  // overwrites the other choice. ---
  const terminalThemeRow = (key: 'terminalThemeDark' | 'terminalThemeLight', type: ThemeType, label: string, hintText: string) => {
    const section = document.createElement('div');
    section.className = 'settings-section';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    section.appendChild(lbl);
    const select = createSettingsSelect(
      getThemesForType(type).map(([k, theme]) => ({ value: k, label: theme.name, selected: k === current[key] })),
    );
    section.appendChild(select.el);
    select.onchange = () => {
      const patch: Partial<AppSettings> = { [key]: select.value };
      update({ ...patch, theme: getEffectiveTheme({ ...loadSettings(), ...patch }) });
    };
    return hint(section, hintText);
  };
  const darkThemeSection = terminalThemeRow('terminalThemeDark', 'dark', t('terminalThemeDark'), t('terminalThemeDarkHint'));
  const lightThemeSection = terminalThemeRow('terminalThemeLight', 'light', t('terminalThemeLight'), t('terminalThemeLightHint'));

  colorSchemeSelect.onchange = () => {
    update({ colorScheme: colorSchemeSelect.value as ColorScheme });
  };

  // --- Background Image ---
  const bgImageSection = document.createElement('div');
  bgImageSection.className = 'settings-section';
  const bgFileName = current.backgroundImage ? current.backgroundImage.split(/[/\\]/).pop() || '' : '';
  bgImageSection.innerHTML = `
    <label>${t('backgroundImage')}</label>
    <div class="settings-btn-row">
      <button class="settings-select" id="bg-image-select" style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(bgFileName || t('backgroundImageSelect'))}</button>
      <button class="settings-select" id="bg-image-clear" style="width:auto;flex:none">${t('backgroundImageClear')}</button>
    </div>
  `;
  const bgSelectBtn = bgImageSection.querySelector('#bg-image-select') as HTMLButtonElement;
  const bgClearBtn = bgImageSection.querySelector('#bg-image-clear') as HTMLButtonElement;
  bgSelectBtn.onclick = async () => {
    const file = await open({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (file) {
      const sourcePath = typeof file === 'string' ? file : file;
      try {
        // Copy image to app internal directory, delete old one if exists
        const internalPath: string = await invoke('copy_background_image', {
          sourcePath: sourcePath as string,
          oldPath: current.backgroundImage || null,
        });
        bgSelectBtn.textContent = (sourcePath as string).split(/[/\\]/).pop() || t('backgroundImageSelect');
        current.backgroundImage = internalPath;
        update({ backgroundImage: internalPath });
        show(bgStrengthSection, true);
      } catch (e) {
        console.error('Failed to copy background image:', e);
      }
    }
  };
  bgClearBtn.onclick = async () => {
    // Delete the stored background image file
    if (current.backgroundImage) {
      try {
        await invoke('delete_background_image', { path: current.backgroundImage });
      } catch (e) {
        console.error('Failed to delete background image:', e);
      }
    }
    bgSelectBtn.textContent = t('backgroundImageSelect');
    current.backgroundImage = '';
    update({ backgroundImage: '' });
    show(bgStrengthSection, false);
  };
  hint(bgImageSection, t('backgroundImageHint'));

  // --- Background Image Strength (only with an image) ---
  const bgStrengthSection = document.createElement('div');
  bgStrengthSection.className = 'settings-section settings-inline settings-row-sub';
  bgStrengthSection.innerHTML = `
    <label>${t('backgroundImageStrength')}: <span id="bg-strength-value">${current.backgroundImageStrength}%</span></label>
    <input type="range" class="settings-slider" id="bg-strength-slider" min="20" max="100" value="${current.backgroundImageStrength}">
  `;
  const bgStrengthSlider = bgStrengthSection.querySelector('#bg-strength-slider') as HTMLInputElement;
  const bgStrengthValue = bgStrengthSection.querySelector('#bg-strength-value') as HTMLSpanElement;
  bgStrengthSlider.oninput = () => {
    const backgroundImageStrength = parseInt(bgStrengthSlider.value, 10);
    bgStrengthValue.textContent = `${backgroundImageStrength}%`;
    update({ backgroundImageStrength });
  };
  show(bgStrengthSection, !!current.backgroundImage);

  // --- Opacity ---
  const opacitySection = document.createElement('div');
  opacitySection.className = 'settings-section settings-inline';
  opacitySection.innerHTML = `
    <label>${t('opacity')}: <span id="opacity-value">${current.opacity}%</span></label>
    <input type="range" class="settings-slider" id="opacity-slider" min="20" max="100" value="${current.opacity}">
  `;
  const opacitySlider = opacitySection.querySelector('#opacity-slider') as HTMLInputElement;
  const opacityValue = opacitySection.querySelector('#opacity-value') as HTMLSpanElement;
  opacitySlider.oninput = () => {
    const opacity = parseInt(opacitySlider.value, 10);
    opacityValue.textContent = `${opacity}%`;
    update({ opacity });
  };
  hint(opacitySection, t('opacityHint'));

  // --- AI Bar Opacity ---
  const aiBarOpacitySection = document.createElement('div');
  aiBarOpacitySection.className = 'settings-section settings-inline';
  aiBarOpacitySection.innerHTML = `
    <label>${t('aiBarOpacity')}: <span id="ai-bar-opacity-value">${current.aiBarOpacity}%</span></label>
    <input type="range" class="settings-slider" id="ai-bar-opacity-slider" min="20" max="100" value="${current.aiBarOpacity}">
  `;
  const aiBarOpacitySlider = aiBarOpacitySection.querySelector('#ai-bar-opacity-slider') as HTMLInputElement;
  const aiBarOpacityValue = aiBarOpacitySection.querySelector('#ai-bar-opacity-value') as HTMLSpanElement;
  aiBarOpacitySlider.oninput = () => {
    const val = parseInt(aiBarOpacitySlider.value, 10);
    aiBarOpacityValue.textContent = `${val}%`;
    update({ aiBarOpacity: val });
  };
  hint(aiBarOpacitySection, t('aiBarOpacityHint'));

  // --- Vibrancy (Background Blur) Toggle ---
  const vibrancySection = document.createElement('div');
  vibrancySection.className = 'settings-section settings-inline';
  vibrancySection.innerHTML = `
    <label>${t('enableVibrancy')}</label>
    <label class="settings-toggle">
      <input type="checkbox" id="vibrancy-toggle" ${current.enableVibrancy ? 'checked' : ''}>
      <span class="settings-toggle-slider"></span>
    </label>
  `;
  const vibrancyToggle = vibrancySection.querySelector('#vibrancy-toggle') as HTMLInputElement;
  vibrancyToggle.onchange = () => {
    update({ enableVibrancy: vibrancyToggle.checked });
  };
  hint(vibrancySection, t('vibrancyHint'));

  // --- Font Size ---
  const fontSection = document.createElement('div');
  fontSection.className = 'settings-section settings-inline';
  fontSection.innerHTML = `
    <label>${t('fontSize')}: <span id="font-value">${current.fontSize}px</span></label>
    <input type="range" class="settings-slider" id="font-slider" min="10" max="24" value="${current.fontSize}">
  `;
  const fontSlider = fontSection.querySelector('#font-slider') as HTMLInputElement;
  const fontValue = fontSection.querySelector('#font-value') as HTMLSpanElement;
  fontSlider.oninput = () => {
    const fontSize = parseInt(fontSlider.value, 10);
    fontValue.textContent = `${fontSize}px`;
    update({ fontSize });
  };
  hint(fontSection, t('fontSizeHint'));

  // --- Font Family ---
  const fontFamilySection = document.createElement('div');
  fontFamilySection.className = 'settings-section';
  fontFamilySection.innerHTML = `<label>${t('fontFamily')}</label>`;
  const fontFamilySelect = createSettingsSelect(
    FONT_REGISTRY
      .filter((f) => !f.isSystem || isMacPlatform) // system fonts only on macOS
      .map((f) => ({ value: f.key, label: f.displayName, selected: f.key === current.fontFamily })),
  );
  fontFamilySection.appendChild(fontFamilySelect.el);
  fontFamilySelect.onchange = () => {
    current.fontFamily = fontFamilySelect.value;
    updateFontToggles();
    update({ fontFamily: fontFamilySelect.value });
  };

  // --- UI Font (interface font — independent of the terminal font) ---
  const uiFontSection = document.createElement('div');
  uiFontSection.className = 'settings-section';
  uiFontSection.innerHTML = `<label>${t('uiFontFamily')}</label>`;
  const uiFontSelect = createSettingsSelect([
    ...UI_FONT_EXTRAS.map((f) => ({ value: f.key, label: f.displayName, selected: f.key === current.uiFontFamily })),
    ...FONT_REGISTRY
      .filter((f) => !f.isSystem || isMacPlatform)
      .map((f) => ({ value: f.key, label: f.displayName, selected: f.key === current.uiFontFamily })),
  ]);
  uiFontSection.appendChild(uiFontSelect.el);
  uiFontSelect.onchange = () => {
    current.uiFontFamily = uiFontSelect.value;
    update({ uiFontFamily: uiFontSelect.value });
  };
  hint(uiFontSection, t('uiFontHint'));

  // --- CJK Font Family ---
  const cjkFontSection = document.createElement('div');
  cjkFontSection.className = 'settings-section';
  cjkFontSection.innerHTML = `<label>${t('cjkFontFamily')}</label>`;
  const availableCJKFonts = getAvailableCJKFonts();
  const cjkOptions = [
    { value: '', label: t('cjkFontAuto'), selected: !current.cjkFontFamily },
    ...availableCJKFonts.map((f) => ({
      value: f.key,
      label: f.displayName,
      selected: f.key === current.cjkFontFamily,
    })),
  ];
  const cjkFontSelect = createSettingsSelect(cjkOptions);
  cjkFontSection.appendChild(cjkFontSelect.el);
  cjkFontSelect.onchange = () => {
    update({ cjkFontFamily: cjkFontSelect.value });
  };
  hint(cjkFontSection, t('cjkFontHint'));

  // --- Font Weight ---
  const fontWeightSection = document.createElement('div');
  fontWeightSection.className = 'settings-section';
  fontWeightSection.innerHTML = `<label>${t('fontWeight')}</label>`;
  const curWeight = current.fontWeight || 400;
  const fontWeightSelect = createSettingsSelect([
    { value: '100', label: 'Thin (100)', selected: curWeight === 100 },
    { value: '200', label: 'Extra Light (200)', selected: curWeight === 200 },
    { value: '300', label: 'Light (300)', selected: curWeight === 300 },
    { value: '400', label: 'Normal (400)', selected: curWeight === 400 },
    { value: '500', label: 'Medium (500)', selected: curWeight === 500 },
    { value: '700', label: 'Bold (700)', selected: curWeight === 700 },
  ]);
  fontWeightSection.appendChild(fontWeightSelect.el);
  fontWeightSelect.onchange = () => { update({ fontWeight: Number(fontWeightSelect.value) }); };

  // --- Font Options (Nerd Font / Ligatures) ---
  const fontOptsSection = document.createElement('div');
  fontOptsSection.className = 'settings-section';
  const fontOptsGroup = document.createElement('div');
  fontOptsGroup.className = 'settings-checkbox-group';
  fontOptsGroup.innerHTML = `
    <label><input type="checkbox" id="nerd-font-toggle" ${current.enableNerdFont ? 'checked' : ''}> ${t('enableNerdFont')}</label>
    <label><input type="checkbox" id="ligatures-toggle" ${current.enableLigatures ? 'checked' : ''}> ${t('enableLigatures')}</label>
    <label><input type="checkbox" id="sharpness-toggle" ${current.fontSharpness ? 'checked' : ''}> ${t('fontSharpness')}</label>
  `;
  fontOptsSection.appendChild(fontOptsGroup);
  const nerdToggle = fontOptsGroup.querySelector('#nerd-font-toggle') as HTMLInputElement;
  const ligToggle = fontOptsGroup.querySelector('#ligatures-toggle') as HTMLInputElement;
  const sharpnessToggle = fontOptsGroup.querySelector('#sharpness-toggle') as HTMLInputElement;
  nerdToggle.onchange = () => { update({ enableNerdFont: nerdToggle.checked }); };
  ligToggle.onchange = () => { update({ enableLigatures: ligToggle.checked }); };
  sharpnessToggle.onchange = () => { update({ fontSharpness: sharpnessToggle.checked }); };

  // --- Encoding ---
  const encodingSection = document.createElement('div');
  encodingSection.className = 'settings-section';
  encodingSection.innerHTML = `<label>${t('encoding')}</label>`;
  const encodingSelect = createSettingsSelect([
    { value: 'utf-8', label: 'UTF-8', selected: current.encoding === 'utf-8' },
    { value: 'gbk', label: 'GBK', selected: current.encoding === 'gbk' },
    { value: 'gb18030', label: 'GB18030', selected: current.encoding === 'gb18030' },
    { value: 'big5', label: 'Big5', selected: current.encoding === 'big5' },
    { value: 'euc-jp', label: 'EUC-JP', selected: current.encoding === 'euc-jp' },
    { value: 'euc-kr', label: 'EUC-KR', selected: current.encoding === 'euc-kr' },
    { value: 'iso-8859-1', label: 'ISO-8859-1', selected: current.encoding === 'iso-8859-1' },
  ]);
  encodingSection.appendChild(encodingSelect.el);
  encodingSelect.onchange = () => {
    update({ encoding: encodingSelect.value });
  };
  hint(encodingSection, t('encodingHint'));

  // --- Default Shell ---
  const shellSection = document.createElement('div');
  shellSection.className = 'settings-section';
  shellSection.innerHTML = `<label>${t('defaultShellSetting')}</label>`;
  const shellSelect = createSettingsSelect([
    { value: '', label: t('systemDefault'), selected: !current.defaultShell },
  ]);
  shellSection.appendChild(shellSelect.el);

  // Populate shell list asynchronously
  void invoke<{ path: string; name: string; is_default: boolean }[]>('list_available_shells').then((shells) => {
    for (const shell of shells) {
      const label = shell.is_default ? `${shell.name} (${t('defaultShell')})` : shell.name;
      shellSelect.addOption(shell.path, label, current.defaultShell === shell.path);
    }
    // If current defaultShell doesn't match any option, keep "System Default" selected
    if (current.defaultShell && !shells.some((s) => s.path === current.defaultShell)) {
      shellSelect.value = '';
    }
  }).catch(() => { /* shells unavailable */ });

  shellSelect.onchange = () => {
    update({ defaultShell: shellSelect.value });
  };
  hint(shellSection, t('defaultShellHint'));

  function updateFontToggles(): void {
    const def = getFontDef(current.fontFamily);
    ligToggle.disabled = !def?.supportsLigatures;
    if (!def?.supportsLigatures && ligToggle.checked) {
      ligToggle.checked = false;
      update({ enableLigatures: false });
    }
  }
  updateFontToggles();

  // --- Context Menu Integration ---
  const ctxMenuSection = document.createElement('div');
  ctxMenuSection.className = 'settings-section settings-inline';
  ctxMenuSection.innerHTML = `
    <label>${t(isMacPlatform ? 'contextMenuIntegrationMac' : 'contextMenuIntegrationWin')}</label>
    <label class="settings-toggle">
      <input type="checkbox" id="context-menu-toggle">
      <span class="settings-toggle-slider"></span>
    </label>
  `;
  const ctxMenuToggle = ctxMenuSection.querySelector('#context-menu-toggle') as HTMLInputElement;

  // Check initial state
  invoke<boolean>('is_context_menu_registered').then((registered) => {
    ctxMenuToggle.checked = registered;
  }).catch(() => { /* ignore */ });

  ctxMenuToggle.onchange = async () => {
    try {
      if (ctxMenuToggle.checked) {
        await invoke('register_context_menu');
      } else {
        await invoke('unregister_context_menu');
      }
    } catch (err) {
      console.error('Context menu toggle failed:', err);
      ctxMenuToggle.checked = !ctxMenuToggle.checked; // revert on failure
    }
  };

  // --- File Manager Font Size ---
  const fileManagerFontSection = document.createElement('div');
  fileManagerFontSection.className = 'settings-section settings-inline';
  fileManagerFontSection.innerHTML = `
    <label>${t('fileManagerFontSize')}: <span id="fm-font-value">${current.fileManagerFontSize}px</span></label>
    <input type="range" class="settings-slider" id="fm-font-slider" min="10" max="18" value="${current.fileManagerFontSize}">
  `;
  const fmFontSlider = fileManagerFontSection.querySelector('#fm-font-slider') as HTMLInputElement;
  const fmFontValue = fileManagerFontSection.querySelector('#fm-font-value') as HTMLSpanElement;
  fmFontSlider.oninput = () => {
    const fileManagerFontSize = parseInt(fmFontSlider.value, 10);
    fmFontValue.textContent = `${fileManagerFontSize}px`;
    update({ fileManagerFontSize });
  };

  // --- File Manager Mode (drawer / sidebar) ---
  const fmModeSection = document.createElement('div');
  fmModeSection.className = 'settings-section';
  fmModeSection.innerHTML = `<label>${t('fileManagerPosition')}</label>`;
  const fmModeSelect = createSettingsSelect([
    { value: 'drawer', label: t('fileManagerPositionDrawer'), selected: current.fileManagerMode === 'drawer' },
    { value: 'sidebar', label: t('fileManagerPositionSidebar'), selected: current.fileManagerMode === 'sidebar' },
  ]);
  fmModeSection.appendChild(fmModeSelect.el);
  fmModeSelect.onchange = () => {
    const fileManagerMode = fmModeSelect.value as 'drawer' | 'sidebar';
    update({ fileManagerMode });
    show(drawerLayoutRow, fileManagerMode === 'drawer');
  };
  hint(fmModeSection, t('fileManagerPositionHint'));

  // --- What double-click does with text and image files (same value as the
  // file list's "Open With" menu) ---
  const fileOpenSection = document.createElement('div');
  fileOpenSection.className = 'settings-section';
  fileOpenSection.innerHTML = `<label>${t('fileOpenPreferenceSetting')}</label>`;
  const fileOpenSelect = createSettingsSelect([
    { value: 'builtin', label: t('ctxMenuBuiltinEditor'), selected: current.fileOpenPreference !== 'system' },
    { value: 'system', label: t('ctxMenuSystemDefault'), selected: current.fileOpenPreference === 'system' },
  ]);
  fileOpenSection.appendChild(fileOpenSelect.el);
  fileOpenSelect.onchange = () => update({ fileOpenPreference: fileOpenSelect.value as AppSettings['fileOpenPreference'] });
  hint(fileOpenSection, t('fileOpenPreferenceHint'));

  // --- Thumbnail Toggle + Preview Refresh Rate ---
  const thumbSection = document.createElement('div');
  thumbSection.className = 'settings-section';
  const thumbGroup = document.createElement('div');
  thumbGroup.className = 'settings-checkbox-group';
  thumbGroup.innerHTML = `<label><input type="checkbox" id="enable-thumbnail-toggle" ${current.enableThumbnail ? 'checked' : ''}> ${t('enableThumbnail')}</label>`;
  thumbSection.appendChild(thumbGroup);
  const thumbCheckbox = thumbGroup.querySelector('#enable-thumbnail-toggle') as HTMLInputElement;

  const rateSection = document.createElement('div');
  rateSection.className = 'settings-section';
  rateSection.innerHTML = `<label>${t('previewRefreshRate')}</label>`;
  const rateSelect = createSettingsSelect([
    { value: '100', label: t('previewRate100'), selected: current.previewRefreshRate === 100 },
    { value: '500', label: t('previewRate500'), selected: current.previewRefreshRate === 500 },
    { value: '1000', label: t('previewRate1000'), selected: current.previewRefreshRate === 1000 },
    { value: '2000', label: t('previewRate2000'), selected: current.previewRefreshRate === 2000 },
    { value: '5000', label: t('previewRate5000'), selected: current.previewRefreshRate === 5000 },
  ]);
  rateSection.appendChild(rateSelect.el);
  rateSection.classList.add('settings-row-sub');
  hint(rateSection, t('previewRefreshRateHint'));
  rateSelect.onchange = () => {
    const previewRefreshRate = parseInt(rateSelect.value, 10);
    update({ previewRefreshRate });
  };
  // Show/hide refresh rate based on thumbnail toggle
  const updateRateVisibility = () => { rateSection.style.display = thumbCheckbox.checked ? '' : 'none'; };
  updateRateVisibility();
  thumbCheckbox.addEventListener('change', () => {
    update({ enableThumbnail: thumbCheckbox.checked });
    updateRateVisibility();
  });

  // --- SSH tab title ---
  const titleSection = document.createElement('div');
  titleSection.className = 'settings-section';
  const titleLabel = document.createElement('label');
  titleLabel.textContent = t('sshTabTitleMode');
  titleSection.appendChild(titleLabel);
  const titleSelect = createSettingsSelect([
    { value: 'connection', label: t('sshTabTitleConnection'), selected: current.sshTabTitleMode === 'connection' },
    { value: 'terminal', label: t('sshTabTitleTerminal'), selected: current.sshTabTitleMode === 'terminal' },
  ]);
  titleSelect.el.setAttribute('aria-label', t('sshTabTitleMode'));
  titleSection.appendChild(titleSelect.el);
  titleSelect.onchange = () => update({ sshTabTitleMode: titleSelect.value as AppSettings['sshTabTitleMode'] });
  hint(titleSection, t('sshTabTitleHint'));

  // --- Remember Options ---
  const rememberSection = document.createElement('div');
  rememberSection.className = 'settings-section';
  const rememberGroup = document.createElement('div');
  rememberGroup.className = 'settings-checkbox-group';
  rememberGroup.innerHTML = `
    <label><input type="checkbox" id="remember-window-size" ${current.rememberWindowSize ? 'checked' : ''}> ${t('rememberWindowSize')}</label>
    <label><input type="checkbox" id="remember-drawer-layout" ${current.rememberDrawerLayout ? 'checked' : ''}> ${t('rememberDrawerLayout')}</label>
    <label><input type="checkbox" id="terminal-notifications-toggle" ${current.enableTerminalNotifications ? 'checked' : ''}> ${t('enableTerminalNotifications')}</label>
    <label><input type="checkbox" id="file-link-confirm-toggle" ${!current.fileLinkSkipConfirm ? 'checked' : ''}> ${t('fileLinkSkipConfirmSetting')}</label>
    <label><input type="checkbox" id="auto-new-session-toggle" ${current.autoNewSession ? 'checked' : ''}> ${t('autoNewSession')}</label>
    <label><input type="checkbox" id="auto-open-ai-toggle" ${current.autoOpenAiOnConnect ? 'checked' : ''}> ${t('autoOpenAiOnConnect')}</label>
    <label><input type="checkbox" id="auto-restore-ai-history-toggle" ${current.autoRestoreAiHistoryOnConnect ? 'checked' : ''}> ${t('autoRestoreAiHistoryOnConnect')}</label>
  `;
  rememberSection.appendChild(rememberGroup);
  const windowSizeCheckbox = rememberGroup.querySelector('#remember-window-size') as HTMLInputElement;
  const drawerLayoutCheckbox = rememberGroup.querySelector('#remember-drawer-layout') as HTMLInputElement;
  const termNotifToggle = rememberGroup.querySelector('#terminal-notifications-toggle') as HTMLInputElement;
  const fileLinkConfirmToggle = rememberGroup.querySelector('#file-link-confirm-toggle') as HTMLInputElement;
  windowSizeCheckbox.onchange = () => { update({ rememberWindowSize: windowSizeCheckbox.checked }); };
  drawerLayoutCheckbox.onchange = () => { update({ rememberDrawerLayout: drawerLayoutCheckbox.checked }); };
  termNotifToggle.onchange = () => { update({ enableTerminalNotifications: termNotifToggle.checked }); };
  fileLinkConfirmToggle.onchange = () => { update({ fileLinkSkipConfirm: !fileLinkConfirmToggle.checked }); };
  const autoNewSessionToggle = rememberGroup.querySelector('#auto-new-session-toggle') as HTMLInputElement;
  autoNewSessionToggle.onchange = () => { update({ autoNewSession: autoNewSessionToggle.checked }); };
  const autoOpenAiToggle = rememberGroup.querySelector('#auto-open-ai-toggle') as HTMLInputElement;
  const autoRestoreAiToggle = rememberGroup.querySelector('#auto-restore-ai-history-toggle') as HTMLInputElement;
  autoOpenAiToggle.onchange = () => {
    update({ autoOpenAiOnConnect: autoOpenAiToggle.checked });
    show(autoRestoreAiRow, autoOpenAiToggle.checked);
  };
  autoRestoreAiToggle.onchange = () => update({ autoRestoreAiHistoryOnConnect: autoRestoreAiToggle.checked });

  // SSH Connections import/export
  const sshIoSection = document.createElement('div');
  sshIoSection.className = 'settings-section';
  sshIoSection.innerHTML = `<label>${t('sshSavedConnections')}</label>`;
  hint(sshIoSection, t('sshSavedConnectionsHint'));

  const sshIoStatus = document.createElement('div');
  sshIoStatus.className = 'settings-ssh-io-status';

  const sshIoBtnRow = document.createElement('div');
  sshIoBtnRow.className = 'settings-btn-row';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'settings-select';
  exportBtn.style.cursor = 'pointer';
  exportBtn.textContent = t('sshExportConnections');
  exportBtn.onclick = async () => {
    try {
      const result = await exportConnectionsToFile();
      if (result === undefined) {
        sshIoStatus.textContent = t('sshNoConnectionsToExport');
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-error';
        return;
      }
      if (result) {
        sshIoStatus.textContent = formatSSHExportResult(result);
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-success';
      }
    } catch {
      sshIoStatus.textContent = t('sshExportFailed');
      sshIoStatus.className = 'settings-ssh-io-status ssh-status-error';
    }
  };

  const importBtn = document.createElement('button');
  importBtn.className = 'settings-select';
  importBtn.style.cursor = 'pointer';
  importBtn.textContent = t('sshImportConnections');
  importBtn.onclick = async () => {
    const filePath = await open({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (filePath) {
      try {
        const content = await readTextFile(filePath as string);
        const result = await importConnectionsFromJSON(content);
        sshIoStatus.textContent = `${result.count} ${t('sshImportCount')}`;
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-success';
        document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
      } catch {
        sshIoStatus.textContent = t('sshImportInvalidFormat');
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-error';
      }
    }
  };

  sshIoBtnRow.appendChild(exportBtn);
  sshIoBtnRow.appendChild(importBtn);
  sshIoSection.appendChild(sshIoBtnRow);
  sshIoSection.appendChild(sshIoStatus);

  sshIoSection.classList.add('settings-section-io');
  const check = (root: HTMLElement, id: string, hintText?: string) => {
    const row = switchRow(root.querySelector<HTMLInputElement>('#' + id));
    return hintText ? hint(row, hintText) : row;
  };
  // Rows that show or hide with another setting.
  const drawerLayoutRow = check(rememberGroup, 'remember-drawer-layout');
  drawerLayoutRow?.classList.add('settings-row-sub');
  show(drawerLayoutRow, current.fileManagerMode === 'drawer');
  const autoRestoreAiRow = check(rememberGroup, 'auto-restore-ai-history-toggle');
  autoRestoreAiRow?.classList.add('settings-row-sub');
  show(autoRestoreAiRow, current.autoOpenAiOnConnect);
  const fontFeatureHint = t('fontFeatureHint');

  const page = (key: string, label: string, icon: string, groups: HTMLElement[]): SettingsPage =>
    ({ key, label, icon, el: createPage(label, groups), searchable: true });

  return [
    page('appearance', t('settingsPageAppearance'), SETTINGS_ICONS.appearance, [
      createGroup(t('settingsGroupGeneral'), [langSection]),
      createGroup(t('settingsGroupTheme'), [colorSchemeSection, darkThemeSection, lightThemeSection, uiFontSection]),
      createGroup(t('settingsGroupBackground'), [opacitySection, vibrancySection, bgImageSection, bgStrengthSection, aiBarOpacitySection]),
    ]),
    page('terminal', t('settingsPageTerminal'), SETTINGS_ICONS.terminal, [
      createGroup(t('settingsGroupFont'), [
        fontSection, fontFamilySection, cjkFontSection, fontWeightSection,
        check(fontOptsGroup, 'nerd-font-toggle', fontFeatureHint), check(fontOptsGroup, 'ligatures-toggle', fontFeatureHint),
        check(fontOptsGroup, 'sharpness-toggle', t('fontSharpnessHint')),
      ]),
      createGroup(t('settingsGroupShell'), [shellSection, encodingSection]),
      createGroup(t('settingsGroupTerminalBehavior'), [
        check(rememberGroup, 'terminal-notifications-toggle', t('terminalNotificationsHint')),
        check(rememberGroup, 'file-link-confirm-toggle', t('fileLinkConfirmHint')),
      ]),
      createGroup(t('settingsGroupCommandAssist'), createCommandAssistRows(current, update)),
    ]),
    page('files', t('settingsPageFileManager'), SETTINGS_ICONS.files, [
      createGroup(t('settingsGroupFmDisplay'), [fmModeSection, drawerLayoutRow, fileManagerFontSection]),
      createGroup(t('settingsGroupFmOpen'), [fileOpenSection]),
    ]),
    page('window', t('settingsPageTabsWindows'), SETTINGS_ICONS.window, [
      createGroup(t('settingsGroupWindow'), [
        check(rememberGroup, 'auto-new-session-toggle', t('autoNewSessionHint')),
        check(rememberGroup, 'remember-window-size', t('rememberWindowSizeHint')),
      ]),
      createGroup(t('settingsGroupTabs'), [titleSection, check(thumbGroup, 'enable-thumbnail-toggle', t('enableThumbnailHint')), rateSection]),
      createGroup(t('settingsGroupSystem'), [ctxMenuSection]),
    ]),
    page('connections', t('settingsPageConnections'), SETTINGS_ICONS.connections, [
      createGroup(t('settingsGroupOnConnect'), [check(rememberGroup, 'auto-open-ai-toggle', t('autoOpenAiOnConnectHint')), autoRestoreAiRow]),
      createGroup(t('settingsGroupImportExport'), [sshIoSection]),
    ]),
  ];
}
