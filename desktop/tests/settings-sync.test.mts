import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { changedSettingKeys, createTrailingThrottle, isLiveAppearanceOnly, SETTINGS_PANEL_KEYS } from '../src/settings-sync.ts';

const read = (file: string) => readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');

test('changedSettingKeys compares values, including nested ones', () => {
  const a = { opacity: 90, fontSize: 14, nbCustomColors: { '--nb-bg': '#fff' } } as any;
  assert.deepEqual(changedSettingKeys(a, { ...a, nbCustomColors: { '--nb-bg': '#fff' } }), []);
  assert.deepEqual(changedSettingKeys(a, { ...a, opacity: 80 }), ['opacity']);
  assert.deepEqual(changedSettingKeys(a, { ...a, nbCustomColors: { '--nb-bg': '#000' } }), ['nbCustomColors']);
});

test('only purely visual changes skip the full settings refresh', () => {
  assert.equal(isLiveAppearanceOnly(['opacity']), true);
  assert.equal(isLiveAppearanceOnly(['opacity', 'aiBarOpacity', 'pipScale']), true);
  assert.equal(isLiveAppearanceOnly(['opacity', 'fontSize']), false);
  // An event with no visible change (e.g. only credentials) keeps the full path.
  assert.equal(isLiveAppearanceOnly([]), false);
});

test('window frame changes from other windows do not rebuild the settings panel', () => {
  for (const key of ['windowWidth', 'windowHeight', 'windowX', 'windowY', 'windowMaximized', 'drawerHeight', 'aiActiveModel']) {
    assert.equal(SETTINGS_PANEL_KEYS.has(key), false, key);
  }
  assert.equal(SETTINGS_PANEL_KEYS.has('fontSize'), true);
});

test('throttle runs at once, coalesces a burst and always delivers the last call', async () => {
  let runs = 0;
  const th = createTrailingThrottle(() => { runs++; }, 20);
  th.schedule();
  assert.equal(runs, 1);
  for (let i = 0; i < 10; i++) th.schedule();
  assert.equal(runs, 1);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(runs, 2);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(runs, 2);
});

test('throttle flush delivers a pending call immediately and only once', () => {
  let runs = 0;
  const th = createTrailingThrottle(() => { runs++; }, 1000);
  th.schedule(); th.schedule();
  th.flush();
  assert.equal(runs, 2);
  th.flush();
  assert.equal(runs, 2);
});

test('settings window throttles its broadcast and follows outside changes', () => {
  const src = read('settings-window.ts');
  assert.match(src, /createTrailingThrottle\(/);
  assert.match(src, /broadcast\.schedule\(\)/);
  assert.match(src, /listen\('settings-changed', resync\)/);
  // The broadcast must still wait for the credential write.
  assert.match(src, /flushSettingsSecrets\(\)\s*\.then\(\(\) => emit\('settings-changed'\)\)/);
});

test('settings labels come from i18n, not inline language checks', () => {
  assert.doesNotMatch(read('settings-general.ts'), /language === 'zh'/);
  assert.doesNotMatch(read('settings.ts'), /getRateLabel/);
});
