import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');

test('every toggle the general settings create is placed on a page', () => {
  const src = read('settings-general.ts');
  const created = [...src.matchAll(/<label><input type="checkbox" id="([\w-]+)"/g)].map(m => m[1]);
  const placed = new Set([...src.matchAll(/check\(\w+, '([\w-]+)'[,)]/g)].map(m => m[1]));
  assert.ok(created.length >= 11);
  for (const id of created) assert.ok(placed.has(id), `${id} is created but never shown`);
});

test('every general settings section is placed on a page', () => {
  const src = read('settings-general.ts');
  const layout = src.slice(src.indexOf('return ['));
  const sections = [...src.matchAll(/const (\w+Section) = document\.createElement\('div'\);/g)].map(m => m[1]);
  // Sections only used as containers for switch rows are placed through check().
  const containers = new Set(['fontOptsSection', 'thumbSection', 'rememberSection']);
  for (const name of sections) {
    if (containers.has(name)) continue;
    assert.match(layout, new RegExp(`\\b${name}\\b`), `${name} is built but not placed`);
  }
});

test('settings window opens resizable at the sidebar size and keeps old tab links working', () => {
  assert.match(read('view-manager.ts'), /width: 720,\s*height: 520,\s*resizable: true/);
  assert.match(read('settings.ts'), /general: 'appearance'/);
  assert.match(read('settings-window.ts'), /\.settings-nav-item\.active/);
});
