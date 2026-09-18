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
  const exports: any = {}; let mode = 'default', refreshes = 0;
  const code = ts.transpileModule(readFileSync(new URL('../src/group-sort-menu.ts', import.meta.url),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, document, window, require: (name: string) => name === './i18n' ? { t: (key: string) => key } : {
    CONNECTION_SORT_MODES: ['default','ip-asc','ip-desc','name-asc','name-desc'], getGroupSort: () => mode, setGroupSort: (_:string,m:string) => { mode=m; }
  } });
  const open = () => exports.showGroupSortMenu(anchor,'a', () => refreshes++);
  const key = (key: string) => listeners.get('keydown')?.({ key, preventDefault() {} });
  return { body, anchor, document, listeners, open, key, get mode() { return mode; }, get refreshes() { return refreshes; } };
}
test('menu navigates by keyboard, Escape restores anchor focus and removes listeners', () => {
  const h = harness(); h.open(); const menu = h.body.children[1];
  assert.equal(menu.attrs.role,'menu'); assert.equal(menu.children[0].attrs['aria-checked'],'true');
  assert.equal(h.document.activeElement, menu.children[0]); h.key('ArrowDown'); assert.equal(h.document.activeElement,menu.children[1]);
  h.key('End'); assert.equal(h.document.activeElement,menu.children[4]); h.key('ArrowDown'); assert.equal(h.document.activeElement,menu.children[0]);
  h.key('Home'); h.key('ArrowUp'); assert.equal(h.document.activeElement,menu.children[4]);
  h.key('Escape'); assert.equal(h.document.activeElement,h.anchor); assert.equal(h.body.children.length,1);
  assert.equal(h.anchor.attrs['aria-expanded'],'false'); assert.equal(h.listeners.size,0);
});
test('selection immediately persists and refreshes, current mode is checked on reopening', () => {
  const h = harness(); h.open(); h.body.children[1].children[2].onclick?.();
  assert.equal(h.mode,'ip-desc'); assert.equal(h.refreshes,1); assert.equal(h.document.activeElement,h.anchor);
  h.open(); assert.equal(h.body.children[1].children[2].attrs['aria-checked'],'true');
});
test('outside click, repeat click, Tab and resize close the menu', () => {
  const h = harness(); h.open(); h.listeners.get('pointerdown')?.({ target: h.body }); assert.equal(h.body.children.length,1);
  h.open(); h.open(); assert.equal(h.body.children.length,1);
  h.open(); h.key('Tab'); assert.equal(h.body.children.length,1); assert.equal(h.document.activeElement,h.anchor);
  h.open(); h.listeners.get('resize')?.(); assert.equal(h.body.children.length,1);
});
