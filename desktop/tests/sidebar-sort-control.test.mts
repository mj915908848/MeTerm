import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('sort controls remain visible in collapsed groups and never trigger collapse', () => {
  class Element {
    children: Element[] = []; innerHTML=''; className=''; dataset: any={}; textContent=''; attrs:any={};
    style={}; clientHeight=0; scrollHeight=0; scrollTop=0; onclick?:Function;
    classList={ remove() {}, toggle() {} }; appendChild(el:Element) { this.children.push(el); }
    setAttribute(k:string,v:string) { this.attrs[k]=v; }
  }
  let collapses=0, menus=0, refreshes=0;
  const exports:any={};
  const items=[{ key:'ssh:a', name:'a', raw:{host:'10.0.0.2',port:22} }, {key:'ssh:b', name:'b',raw:{host:'10.0.0.1',port:22}}];
  const mocks:any={
    './connection-sort': {sortGroupConnections:(x:any)=>[...x]},
    './group-sort-menu': {showGroupSortMenu:()=>menus++},
    './i18n': {t:(x:string)=>x}, './icons':{icon:()=>''}, './app-state':{settings:{language:'zh'}},
    './home-dashboard-left': {collectAllConnections:()=>items,filterConnections:(x:any)=>x,escapeHtml:(x:string)=>x},
    './connection-groups':{loadGroupMap:()=>({'ssh:a':'prod'}),loadGroupOrder:()=>['prod'],loadGroupCollapsed:()=>new Set(['prod','__ungrouped__']),toggleGroupCollapsed:()=>collapses++},
  };
  const code=ts.transpileModule(readFileSync(new URL('../src/home-side.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
  vm.runInNewContext(code,{exports,document:{createElement:()=>new Element()},require:(x:string)=>mocks[x]});
  const list=new Element();
  exports.renderSidebarList(list,null,'',{refresh:()=>refreshes++,getSelectedKey:()=>null});
  assert.equal(list.children.length,2);
  for(const header of list.children) {
    assert.ok(header.className.includes('collapsed'));
    const button=header.children[0]; assert.equal(button.className,'hsg-sort');
    assert.equal(button.attrs['aria-haspopup'],'menu');
    let stopped=false; button.onclick?.({stopPropagation(){stopped=true;}});
    assert.equal(stopped,true);
  }
  assert.equal(menus,2); assert.equal(collapses,0); assert.equal(refreshes,0);
  list.children[0].onclick?.(); assert.equal(collapses,1); assert.equal(refreshes,1);
});
