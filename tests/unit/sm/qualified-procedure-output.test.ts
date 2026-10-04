/** Explicit procedure links remain continuous with qualified arriving endpoints. */
import { describe, expect, it } from 'vitest';
import { ColumnTracer, reachableColumnEndpoints } from '../../../src/ai/sm/columnTracer';
import type { HopFindingKept } from '../../../src/ai/sm/smTypes';
import { makeModel, makeNode } from './helpers/fixtures';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
const nodes = [
 makeNode({ id:'writer',name:'writer',schema:'dbo',type:'procedure',columns:[],bodyScript:'UPDATE dest SET Amount=src.Amount FROM dbo.owed dest JOIN dbo.source src ON src.Amount=dest.Amount WHERE dest.Stamp > @Cutoff; INSERT dbo.other SELECT Amount, Stamp FROM dbo.owed;' }),
 ...['owed','other','source'].map(id=>makeNode({id,name:id,schema:'dbo',type:'table' as const,columns:[column('Amount'),column('Stamp')]})),
];
const model=makeModel(nodes,[['owed','writer'],['source','writer'],['writer','owed'],['writer','other']],['dbo']);
const map=new Map(nodes.map(n=>[n.id,n]));
function validate(destination:string,direction:'upstream'|'downstream',incoming:{node:string;col:string}[]) {
 const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'Declared SQL',sections:[],column_flow:[{out_col:'Amount',writes_to:{node:destination,col:'Amount'},upstream_columns:[{node:destination==='owed'?'source':'owed',col:'Amount'},{node:'owed',col:'Stamp',transforms:['filter']}]}]};
 return new ColumnTracer(['Amount']).validateColumnFlow('writer',finding,map,model,null,undefined,undefined,direction,incoming);
}
describe('qualified procedure output binding',()=>{
 it('walks only ancestors upstream, preserving siblings for a downstream walk',()=>{
  const links=[{from:'amount',to:'discount'},{from:'amount',to:'archive'},{from:'stamp',to:'archive'}];
  expect([...reachableColumnEndpoints(new Set(['discount']),links,'upstream')].sort()).toEqual(['amount','discount']);
  expect([...reachableColumnEndpoints(new Set(['amount']),links,'downstream')].sort()).toEqual(['amount','archive','discount']);
 });
 it('admits an explicit SQL-real link connected through an arriving source endpoint',()=>{
  const result=validate('other','upstream',[{node:'owed',col:'Amount'}]);
  expect(result.invalidRoutes).toEqual([]);
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'owed',from_col:'Amount',to_node:'other',to_col:'Amount'}));
 });
 it.each(['Amount','amount'])('preserves case-sensitive arriving source identity (%s)',sourceColumn=>{
  const ownMap=new Map(map);
  ownMap.set('owed',{...map.get('owed')!,columns:[column('Amount'),column('amount'),column('Stamp')]});
  const ownModel={...model,nodes:model.nodes.map(node=>ownMap.get(node.id)!),identifierCaseSensitive:true};
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'Explicit source identity',sections:[],column_flow:[
   {out_col:'Amount',writes_to:{node:'other',col:'Amount'},upstream_columns:[{node:'owed',col:sourceColumn}]},
  ]};
  const result=new ColumnTracer(['Amount'],undefined,true).validateColumnFlow('writer',finding,ownMap,ownModel,null,undefined,undefined,'upstream',[{node:'owed',col:'Amount'}]);
  if(sourceColumn==='Amount') {
   expect(result.invalidRoutes).toEqual([]);
   expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'owed',from_col:'Amount',to_node:'other',to_col:'Amount'}));
  } else {
   expect(result.invalidRoutes).toContainEqual(expect.objectContaining({kind:'untracked_out_col'}));
   expect(result.stagedEdges).toEqual([]);
  }
 });
 it('retains both authored destinations and row-selection attribution connected through a shared source',()=>{
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'Two declared writes',sections:[],column_flow:[
   {out_col:'Amount',writes_to:{node:'owed',col:'Amount'},upstream_columns:[{node:'source',col:'Amount'}]},
   {out_col:'Amount',writes_to:{node:'other',col:'Amount'},upstream_columns:[{node:'owed',col:'Amount'},{node:'owed',col:'Stamp',transforms:['filter']}]},
  ]};
  const result=new ColumnTracer(['Amount']).validateColumnFlow('writer',finding,map,model,null,undefined,undefined,'upstream',[{node:'owed',col:'Amount'}]);
  expect(result.invalidRoutes).toEqual([]);
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'source',from_col:'Amount',to_node:'owed',to_col:'Amount'}));
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'owed',from_col:'Amount',to_node:'other',to_col:'Amount'}));
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'owed',from_col:'Stamp',to_node:'other',to_col:'Amount',transforms:['filter']}));
 });
 it.each([undefined,null])('rejects a missing or null write binding to an owed external output (%s)',writes_to=>{
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'No declared write',sections:[],column_flow:[{out_col:'Amount',...(writes_to===undefined?{}:{writes_to}),upstream_columns:[{node:'source',col:'Amount'}]}]};
  const result=new ColumnTracer(['Amount']).validateColumnFlow('writer',finding,map,model,null,undefined,undefined,'upstream',[{node:'owed',col:'Amount'}]);
  expect(result.invalidRoutes).toContainEqual(expect.objectContaining({kind:'untracked_out_col'}));
  expect(result.stagedEdges).toEqual([]);
 });
 it('does not recover an arriving obligation from historic output edges',()=>{
  const tracer=new ColumnTracer(['Amount'],{target_columns:['Amount'],active_columns:['Amount'],edges:[{hop:1,hop_node:'writer',from_node:'other',from_col:'Amount',to_node:'source',to_col:'Stamp'}]});
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'Historical endpoint is not this task',sections:[],column_flow:[{out_col:'Amount',writes_to:{node:'other',col:'Amount'},upstream_columns:[{node:'source',col:'Amount'}]}]};
  const result=tracer.validateColumnFlow('writer',finding,map,model,null,undefined,undefined,'upstream',[{node:'owed',col:'Amount'}]);
  expect(result.invalidRoutes).toContainEqual(expect.objectContaining({kind:'untracked_out_col'}));
  expect(result.stagedEdges).toEqual([]);
 });
 it('rejects a disconnected second destination without recovering continuity from a shared writer name',()=>{
  const ownMap=new Map(map);ownMap.set('other',{...map.get('other')!,type:'view'});
  const ownModel={...model,nodes:model.nodes.map(node=>ownMap.get(node.id)!)};
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'Multiple real writes, only one owed output',sections:[],column_flow:[
   {out_col:'Amount',writes_to:{node:'owed',col:'Amount'},upstream_columns:[{node:'source',col:'Amount'}]},
   {out_col:'Amount',writes_to:{node:'other',col:'Amount'},upstream_columns:[{node:'source',col:'Stamp'},{node:'owed',col:'Stamp',transforms:['filter']}]},
  ]};
  const result=new ColumnTracer(['Amount']).validateColumnFlow('writer',finding,ownMap,ownModel,null,undefined,undefined,'upstream',[{node:'owed',col:'Amount'}]);
  expect(result.invalidRoutes).toContainEqual(expect.objectContaining({kind:'untracked_out_col',path:'column_flow.1.upstream_columns'}));
  expect(result.stagedEdges.some(e=>e.to_node==='other')).toBe(false);
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'source',from_col:'Amount',to_node:'owed',to_col:'Amount'}));
 });
 it('keeps a genuinely arriving local output renamed at its explicit write target',()=>{
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'Local output writes Amount',sections:[],column_flow:[{out_col:'LocalValue',writes_to:{node:'owed',col:'Amount'},upstream_columns:[{node:'source',col:'Amount'}]}]};
  const result=new ColumnTracer(['LocalValue']).validateColumnFlow('writer',finding,map,model,null,undefined,undefined,'upstream',[{node:'writer',col:'LocalValue'}]);
  expect(result.invalidRoutes).toEqual([]);
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'writer',from_col:'LocalValue',to_node:'owed',to_col:'Amount'}));
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'source',from_col:'Amount',to_node:'owed',to_col:'Amount'}));
 });
 it('binds an arriving local output to an explicit view destination without inventing a writer edge',()=>{
  const target=makeNode({id:'owed',name:'owed',schema:'dbo',type:'view',columns:[column('Amount')]});
  const ownMap=new Map(map);ownMap.set('owed',target);
  const ownModel=makeModel(nodes.map(n=>n.id==='owed'?target:n),[['source','writer'],['writer','owed']],['dbo']);
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'Local output writes Amount',sections:[],column_flow:[{out_col:'LocalValue',writes_to:{node:'owed',col:'Amount'},upstream_columns:[{node:'source',col:'Amount'}]}]};
  const result=new ColumnTracer(['LocalValue']).validateColumnFlow('writer',finding,ownMap,ownModel,null,undefined,undefined,'upstream',[{node:'writer',col:'LocalValue'}]);
  expect(result.invalidRoutes).toEqual([]);
  expect(result.stagedEdges).toEqual([expect.objectContaining({from_node:'source',from_col:'Amount',to_node:'owed',to_col:'Amount'})]);
 });
 it.each(['table','view'] as const)('rejects an unrelated terminal output at a mixed-side hop (target=%s)',type=>{
  const target=makeNode({id:'source',name:'source',schema:'dbo',type,columns:[column('Amount'),column('Stamp')]});
  const ownMap=new Map(map);ownMap.set('source',target);
  const ownModel=makeModel(nodes.map(n=>n.id==='source'?target:n),[['source','writer'],['writer','owed'],['writer','source']],['dbo']);
  const finding:HopFindingKept={focus_node_id:'writer',verdict:'analyze',summary:'One owed terminal, one unrelated terminal',sections:[],column_flow:[
   {out_col:'Amount',writes_to:{node:'owed',col:'Amount'},upstream_columns:[]},
   {out_col:'Unused',writes_to:{node:'source',col:'Stamp'},upstream_columns:[]},
  ]};
  const result=new ColumnTracer(['Amount']).validateColumnFlow('writer',finding,ownMap,ownModel,null,undefined,undefined,'upstream',[{node:'owed',col:'Amount'}],[],[],[{node:'other',col:'Amount'}]);
  expect(result.invalidRoutes).toContainEqual(expect.objectContaining({kind:'untracked_out_col',path:'column_flow.1.upstream_columns'}));
  expect(result.stagedEdges.some(edge=>edge.to_node==='source'&&edge.to_col==='Stamp')).toBe(false);
 });
 it('retains real row-selection contributors to the owed output',()=>{
  const result=validate('owed','upstream',[{node:'owed',col:'Amount'}]);
  expect(result.invalidRoutes).toEqual([]);
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'owed',from_col:'Stamp',to_node:'owed',to_col:'Amount',transforms:['filter']}));
 });
 it('allows a downstream additional output derived from the arriving input',()=>{
  const result=validate('other','downstream',[{node:'owed',col:'Amount'}]);
  expect(result.invalidRoutes).toEqual([]);
  expect(result.stagedEdges).toContainEqual(expect.objectContaining({from_node:'owed',from_col:'Stamp',to_node:'other',to_col:'Amount'}));
 });
});

function navigation(mode:'bb'|'ct',restore:boolean) {
 const ns=[makeNode({id:'root',name:'root',schema:'dbo',type:'view',columns:[column('Net')]}),
  ...['owed','other','source'].map(id=>makeNode({id,name:id,schema:'dbo',type:'table' as const,columns:[column('Amount'),column('Stamp')]})),
  makeNode({id:'archiveWriter',name:'archiveWriter',schema:'dbo',type:'procedure',columns:[],bodyScript:'INSERT dbo.other SELECT Amount, Stamp FROM dbo.owed; DELETE dbo.owed WHERE Stamp < @Cutoff;'}),
  makeNode({id:'producer',name:'producer',schema:'dbo',type:'procedure',columns:[],bodyScript:'INSERT dbo.owed SELECT Amount, Stamp FROM dbo.source WHERE Stamp > @Cutoff;'})];
 const ps:Array<[string,string]>=[['owed','root'],['archiveWriter','owed'],['owed','archiveWriter'],['archiveWriter','other'],['source','producer'],['producer','owed']];
 const model=makeModel(ns,ps,['dbo']);const graph=makeGraph(ns,ps);let e=new NavigationEngine(model,graph,()=>{},{});
 expect(e.init({origin:'root',question:'Trace Net',direction:'upstream',analysisMode:mode,...(mode==='ct'?{targetColumns:['Net']}:{}),depthIntent:{upstream:{levels:'all',exactness:'exact'},downstream:{levels:0,exactness:'exact'}}})).toMatchObject({ok:true});
 e.getHopContext();expect(e.submitFindings({focus_node_id:'root',verdict:'analyze',summary:'Net uses owed Amount',sections:[{angle:'technical',text:'Declared SQL'}],...(mode==='ct'?{column_flow:[{out_col:'Net',upstream_columns:[{node:'owed',col:'Amount'}]}]}:{})})).toMatchObject({ok:true});
 if(restore)e=NavigationEngine.fromJSON(e.toJSON(),model,graph,()=>{});
 expect(e.getHopContext()).toMatchObject({focus_node:{id:'archiveWriter'}});
 if(mode==='ct') {
  const edgesBefore=JSON.stringify(e.columnAspect?.edges);
  expect(e.submitFindings({focus_node_id:'archiveWriter',verdict:'analyze',summary:'Archives rows; destination is other',sections:[{angle:'technical',text:'Row deletion remains explained'}],column_flow:[{out_col:'Amount',writes_to:{node:'other',col:'Amount'},upstream_columns:[{node:'owed',col:'Stamp',transforms:['filter']}]}]})).toMatchObject({code:'out_col_not_tracked'});
  expect(JSON.stringify(e.columnAspect?.edges)).toBe(edgesBefore);
 }
 expect(e.submitFindings({focus_node_id:'archiveWriter',verdict:'analyze',summary:'Deletes old rows; no amount write to owed',sections:[{angle:'technical',text:'Stamp selects deleted rows; archival values are outside the requested output.'}],...(mode==='ct'?{column_flow:[]}:{})})).toMatchObject({ok:true});
 if(restore)e=NavigationEngine.fromJSON(e.toJSON(),model,graph,()=>{});
 expect(e.getHopContext()).toMatchObject({focus_node:{id:'producer'}});
 if(mode==='ct') {
  expect(e.columnAspect?.active_columns).toEqual(['Amount']);
  expect(e.getCurrentTasks().flatMap(t=>t.kind==='column_lineage'?t.sourceRefs??[]:[])).not.toContainEqual({node:'owed',col:'Stamp'});
 }
 expect(e.submitFindings({focus_node_id:'producer',verdict:'analyze',summary:'Loads Amount with a real row selector',sections:[{angle:'technical',text:'Source Stamp selects rows.'}],...(mode==='ct'?{column_flow:[{out_col:'Amount',writes_to:{node:'owed',col:'Amount'},upstream_columns:[{node:'source',col:'Amount'},{node:'source',col:'Stamp',transforms:['filter']}]}]}:{})})).toMatchObject({ok:true});
 expect(e.getHopContext()).toMatchObject({done:true});
 const result=e.getResult();
 if(mode==='ct')expect(e.columnAspect?.edges).toContainEqual(expect.objectContaining({from_node:'source',from_col:'Stamp',to_node:'owed',to_col:'Amount',transforms:['filter']}));
 return {nodes:result.fullNodes.map(n=>n.id).sort(),edges:result.edges.map(x=>JSON.stringify(x)).sort()};
}
it.each([false,true])('keeps BB/CT object parity without propagating an unbound archive selector (restore=%s)',restore=>{
 expect(navigation('ct',restore)).toEqual(navigation('bb',restore));
});
