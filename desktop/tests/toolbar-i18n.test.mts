import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// toolbar.ts used to resolve its labels with inline language checks
// (`settings?.language === 'zh' ? '中文' : 'English'`), which bypasses the
// translation table: anything built that way never shows up in a translation
// audit and silently drifts from the rest of the UI. These tests pin down that
// the toolbar resolves every user-facing string through `t()`.

const toolbarSrc = readFileSync(new URL('../src/toolbar.ts', import.meta.url), 'utf8');
const i18nSrc = readFileSync(new URL('../src/i18n.ts', import.meta.url), 'utf8');

const enAt = i18nSrc.indexOf('\n  en: {');
const zhAt = i18nSrc.indexOf('\n  zh: {');
assert.ok(enAt > 0 && zhAt > enAt, 'could not locate the en/zh translation blocks');
const enBlock = i18nSrc.slice(enAt, zhAt);
const zhBlock = i18nSrc.slice(zhAt);

function valueOf(block: string, key: string): string | undefined {
  return new RegExp(`^\\s+${key}: '([^']*)',\\s*$`, 'm').exec(block)?.[1];
}

// Keys introduced when toolbar.ts moved off inline language checks.
const TOOLBAR_KEYS = [
  'appMenuTitle',
  'appMenuNewWindow',
  'appMenuImportConnections',
  'appMenuExportConnections',
  'appMenuCloseAllSessions',
  'appMenuCloseWindow',
  'appMenuQuit',
  'toolbarAiAgent',
  'toolbarAlwaysOnTop',
  'toolbarUnpinFromTop',
  'toolbarPictureInPicture',
  'toolbarExitPictureInPicture',
  'windowMinimize',
  'windowMaximize',
  'windowRestore',
  'windowClose',
];

test('toolbar.ts does not pick user-facing strings inline from settings.language', () => {
  assert.ok(
    !toolbarSrc.includes("language === 'zh'"),
    'toolbar.ts must resolve text through t(), not an inline language check',
  );
});

test('every toolbar i18n key is defined in both languages and actually wired up', () => {
  for (const key of TOOLBAR_KEYS) {
    assert.ok(valueOf(enBlock, key), `${key} is missing from the en translations`);
    assert.ok(valueOf(zhBlock, key), `${key} is missing from the zh translations`);
    assert.ok(
      toolbarSrc.includes(`t('${key}')`),
      `${key} is translated but never used by toolbar.ts`,
    );
  }
});

test('toolbar translations are not left untranslated (zh must differ from en)', () => {
  for (const key of TOOLBAR_KEYS) {
    assert.notEqual(
      valueOf(zhBlock, key),
      valueOf(enBlock, key),
      `${key} carries the en text in the zh block`,
    );
  }
});
