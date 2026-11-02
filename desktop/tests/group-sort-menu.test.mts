import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  const listeners = new Map<string, Function>();
  let active: Element | undefined;
  class Element {
    children: Element[] = []; attrs: Record<string, string> = {}; style = {}; dataset: any = {};
    isConnected = true; offsetWidth = 160; offsetHeight = 170; onclick?: Function;
    parent?: Element; className = ''; textContent = ''; tabIndex = 0;
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    appendChild(el: Element) { this.children.push(el); el.parent = this; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
    contains(el: Element) { return this === el || this.children.some(x => x.contains(el)); }
    focus() { active = this; }
    getBoundingClientRect() { return { right: 300, bottom: 40 }; }
  }
  const body = new Element(), anchor = new Element(); anchor.dataset.group = 'a'; body.appendChild(anchor);
  const document = { body, get activeElement() { return active; }, createElement: () => new Element(),
    querySelectorAll: () => [anchor], addEventListener: (k: string, f: Function) => listeners.set(k,f),
    removeEventListener: (k: string) => listeners.delete(k) };
  const window = { innerWidth: 500, innerHeight: 400, addEventListener: (k: string,f: Function) => listeners.set(k,f), removeEventListener: (k: string) => listeners.delete(k) };
  const exports: any = {}; let mode = 'added-asc', refreshes = 0;
  const code = ts.transpileModule(readFileSync(new URL('../src/group-sort-menu.ts', import.meta.url),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, document, window, require: (name: string) => name === './i18n' ? { t: (key: string) => key } : {
    CONNECTION_SORT_KEYS: ['name','added'], CONNECTION_SORT_DIRECTIONS: ['asc','desc'],
    sortModeKey: (m: string) => m.split('-')[0], sortModeDirection: (m: string) => m.split('-')[1],
    getGroupSort: () => mode, setGroupSort: (_:string,m:string) => { mode=m; }
  } });
  const open = () => exports.showGroupSortMenu(anchor,'a', () => refreshes++);
  const key = (key: string) => listeners.get('keydown')?.({ key, preventDefault() {} });
  return { body, anchor, document, listeners, open, key, get mode() { return mode; }, get refreshes() { return refreshes; } };
}
// Menu children: [名称, 添加日期, divider, 升序, 降序].
const buttonsOf = (menu: any) => menu.children.filter((x: any) => x.attrs.role === 'menuitemradio');
test('menu navigates by keyboard, Escape restores anchor focus and removes listeners', () => {
  const h = harness(); h.open(); const menu = h.body.children[1]; const items = buttonsOf(menu);
  assert.equal(menu.attrs.role,'menu'); assert.equal(items.length, 4); assert.equal(menu.children[2].attrs.role, 'separator');
  assert.deepEqual(items.map((x: any) => x.attrs['aria-checked']), ['false','true','true','false']);
  assert.equal(h.document.activeElement, items[1]); h.key('ArrowDown'); assert.equal(h.document.activeElement,items[2]);
  h.key('End'); assert.equal(h.document.activeElement,items[3]); h.key('ArrowDown'); assert.equal(h.document.activeElement,items[0]);
  h.key('Home'); h.key('ArrowUp'); assert.equal(h.document.activeElement,items[3]);
  h.key('Escape'); assert.equal(h.document.activeElement,h.anchor); assert.equal(h.body.children.length,1);
  assert.equal(h.anchor.attrs['aria-expanded'],'false'); assert.equal(h.listeners.size,0);
});
test('key and direction are picked independently, persist at once and keep the menu open', () => {
  const h = harness(); h.open(); const items = buttonsOf(h.body.children[1]);
  items[0].onclick?.();
  assert.equal(h.mode,'name-asc'); assert.equal(h.refreshes,1); assert.equal(h.body.children.length,2);
  items[3].onclick?.();
  assert.equal(h.mode,'name-desc'); assert.equal(h.refreshes,2);
  assert.deepEqual(items.map((x: any) => x.attrs['aria-checked']), ['true','false','false','true']);
  h.key('Escape'); h.open();
  assert.deepEqual(buttonsOf(h.body.children[1]).map((x: any) => x.attrs['aria-checked']), ['true','false','false','true']);
});
test('outside click, repeat click, Tab and resize close the menu', () => {
  const h = harness(); h.open(); h.listeners.get('pointerdown')?.({ target: h.body }); assert.equal(h.body.children.length,1);
  h.open(); h.open(); assert.equal(h.body.children.length,1);
  h.open(); h.key('Tab'); assert.equal(h.body.children.length,1); assert.equal(h.document.activeElement,h.anchor);
  h.open(); h.listeners.get('resize')?.(); assert.equal(h.body.children.length,1);
});
