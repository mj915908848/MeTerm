import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

/**
 * Group headers carry no sort button any more (a button on every header made the
 * list a column of icons). Sorting is in the header's right-click menu: a surface
 * with its own group menu (the home page) is handed the event, any other list
 * (the drawer) gets the sort modes directly. Neither may collapse the group.
 */
function render(deps: any) {
  class Element {
    children: Element[] = []; innerHTML=''; className=''; dataset: any={}; textContent=''; attrs:any={}; title='';
    style={}; clientHeight=0; scrollHeight=0; scrollTop=0; onclick?:Function; oncontextmenu?:Function;
    classList={ remove() {}, toggle() {} }; appendChild(el:Element) { this.children.push(el); }
    setAttribute(k:string,v:string) { this.attrs[k]=v; }
  }
  const calls = { collapses: 0, menus: [] as any[] };
  const exports:any={};
  const items=[{ key:'ssh:a', name:'a', raw:{host:'10.0.0.2',port:22} }, {key:'ssh:b', name:'b',raw:{host:'10.0.0.1',port:22}}];
  const mocks:any={
    './connection-sort': {sortGroupConnections:(x:any)=>[...x]},
    './group-sort-menu': {showGroupSortMenu:(at:any, group:string)=>calls.menus.push({at, group})},
    './i18n': {t:(x:string)=>x}, './icons':{icon:()=>''}, './app-state':{settings:{language:'zh'}},
    './home-dashboard-left': {collectAllConnections:()=>items,filterConnections:(x:any)=>x,escapeHtml:(x:string)=>x},
    './connection-groups':{loadGroupMap:()=>({'ssh:a':'prod'}),loadGroupOrder:()=>['prod'],loadGroupColors:()=>({}),loadGroupCollapsed:()=>new Set(['prod','__ungrouped__']),toggleGroupCollapsed:()=>calls.collapses++,visibleGroupName:(stored:string|null|undefined)=>(stored&&!stored.startsWith('__')?stored:null)},
  };
  const code=ts.transpileModule(readFileSync(new URL('../src/home-side.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
  vm.runInNewContext(code,{exports,document:{createElement:()=>new Element()},require:(x:string)=>mocks[x]});
  const list=new Element();
  exports.renderSidebarList(list,null,'',{refresh:()=>{},getSelectedKey:()=>null,...deps});
  return { list, calls };
}

const rightClick = { clientX: 40, clientY: 90, preventDefault() {} };

test('group headers have no sort button', () => {
  const { list } = render({});
  assert.equal(list.children.length, 2);
  for (const header of list.children) assert.equal(header.children.length, 0, 'nothing but the header text');
  assert.doesNotMatch(readFileSync(new URL('../src/home-side.ts', import.meta.url), 'utf8'), /hsg-sort/);
});

test('without a group menu, right-clicking a header opens the sort modes at the pointer', () => {
  const { list, calls } = render({});
  list.children[0].oncontextmenu!(rightClick);
  list.children[1].oncontextmenu!(rightClick);
  assert.deepEqual(calls.menus.map((m) => m.group), ['prod', '__ungrouped__']);
  assert.deepEqual({ ...calls.menus[0].at }, { x: 40, y: 90 });
  assert.equal(calls.collapses, 0, 'a right-click never collapses the group');
});

test('a surface with its own group menu gets the right-click instead', () => {
  const seen: (string | null)[] = [];
  const { list, calls } = render({ onGroupContextMenu: (_e: any, g: string | null) => seen.push(g) });
  list.children[0].oncontextmenu!(rightClick);
  list.children[1].oncontextmenu!(rightClick);
  assert.deepEqual(seen, ['prod', null]);
  assert.equal(calls.menus.length, 0);
});
