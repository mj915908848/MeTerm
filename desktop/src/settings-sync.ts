import type { AppSettings } from './themes';

/**
 * Settings that only change how the window looks and can be applied without
 * reloading fonts, re-theming every terminal or rebuilding the home view.
 * Their sliders fire many times a second while dragged.
 */
export const LIVE_APPEARANCE_KEYS: ReadonlySet<string> = new Set([
  'opacity',
  'backgroundImageStrength',
  'aiBarOpacity',
  'enableVibrancy',
]);

/**
 * Settings the settings window shows. Other windows write plenty of fields the
 * panel never displays (window frame, drawer height, active model), and those
 * must not rebuild the panel under the user.
 */
export const SETTINGS_PANEL_KEYS: ReadonlySet<string> = new Set([
  'theme', 'terminalThemeDark', 'terminalThemeLight', 'colorScheme', 'opacity', 'fontSize', 'fontFamily', 'uiFontFamily', 'cjkFontFamily',
  'enableNerdFont', 'enableLigatures', 'fontWeight', 'fontSharpness', 'encoding',
  'enableThumbnail', 'previewRefreshRate', 'language', 'sshTabTitleMode',
  'autoOpenAiOnConnect', 'autoRestoreAiHistoryOnConnect', 'rememberWindowSize',
  'fileManagerFontSize', 'fileManagerMode', 'rememberDrawerLayout', 'backgroundImage', 'backgroundImageStrength',
  'enableTerminalNotifications', 'defaultShell', 'aiBarOpacity', 'aiMaxTokens',
  'aiTemperature', 'aiContextLines', 'aiHistoryBudgetTokens', 'aiEnableThinking',
  'aiThinkingBudget', 'aiAgentTrustLevel', 'aiAgentMaxIterations', 'aiPermissionMode',
  'aiSaveChatHistory', 'aiChatHistoryLimit',
  'searxngUrl', 'searxngUsername', 'searxngEnabled', 'fileLinkSkipConfirm',
  'enableVibrancy', 'tldrEnabled', 'cmdCompletionEnabled', 'shellHookInjection',
  'autoNewSession', 'fileOpenPreference',
  'terminalScrollback', 'terminalCursorStyle', 'terminalCursorBlink', 'copyOnSelect', 'terminalRightClick',
  'macOptionIsMeta', 'commandSnippets',
]);

/** Top-level keys whose values differ between two settings snapshots. */
export function changedSettingKeys(prev: AppSettings | undefined, next: AppSettings): string[] {
  if (!prev) return Object.keys(next);
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** True when a change touched only cheap, purely visual settings. */
export function isLiveAppearanceOnly(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((k) => LIVE_APPEARANCE_KEYS.has(k));
}

/**
 * Runs `fn` at once, then at most once per `intervalMs` while calls keep
 * coming; a call that lands inside the interval is coalesced into one trailing
 * run, so the last value is always delivered.
 */
export function createTrailingThrottle(fn: () => void, intervalMs: number): { schedule(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  const tick = () => {
    if (pending) {
      pending = false;
      fn();
      timer = setTimeout(tick, intervalMs);
    } else {
      timer = null;
    }
  };
  return {
    schedule() {
      if (timer) { pending = true; return; }
      fn();
      timer = setTimeout(tick, intervalMs);
    },
    flush() {
      if (!pending) return;
      pending = false;
      if (timer) clearTimeout(timer);
      timer = null;
      fn();
    },
  };
}
