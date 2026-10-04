/** Bidirectional sessions use each arriving column task's declared traversal side. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeModel, makeNode } from './helpers/fixtures';
import { makeGraph } from '../helpers/testUtils';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
const column=(name:string)=>({name,type:'int',nullable:'NULL' as const,extra:''});

describe('qualified arriving hop direction',()=>{
 it.each([false,true])('accepts an authored downstream procedure write in a bidirectional session (restore=%s)',restore=>{
  const nodes=[makeNode({id:'origin',name:'origin',schema:'dbo',type:'view',columns:[column('Discount')],bodyScript:'SELECT Amount AS Discount FROM dbo.source;'}),
   makeNode({id:'source',name:'source',schema:'dbo',type:'table',columns:[column('Amount')]}),
   makeNode({id:'consumer',name:'consumer',schema:'dbo',type:'procedure',columns:[],bodyScript:'INSERT dbo.destination(Discount) SELECT Discount FROM dbo.origin;'}),
   makeNode({id:'destination',name:'destination',schema:'dbo',type:'table',columns:[column('Discount')]})];
  const pairs:Array<[string,string]>=[['source','origin'],['origin','consumer'],['consumer','destination']];
  const model=makeModel(nodes,pairs,['dbo']);const graph=makeGraph(nodes,pairs);let engine=new NavigationEngine(model,graph,()=>{},{});
  expect(engine.init({origin:'origin',question:'Trace Discount sources and consumers',direction:'bidirectional',analysisMode:'ct',targetColumns:['Discount'],depthIntent:{upstream:{levels:'all',exactness:'exact'},downstream:{levels:'all',exactness:'exact'}}})).toMatchObject({ok:true});
  expect(engine.getHopContext()).toMatchObject({focus_node:{id:'origin'}});
  expect(engine.submitFindings({focus_node_id:'origin',verdict:'analyze',summary:'Discount reads Amount',sections:[{angle:'technical',text:'SELECT Amount AS Discount FROM dbo.source;'}],column_flow:[{out_col:'Discount',upstream_columns:[{node:'source',col:'Amount'}]}],questions:[{nodeId:'consumer',question:'Confirm how it consumes the Discount output.'}]})).toMatchObject({ok:true});
  if(restore)engine=NavigationEngine.fromJSON(engine.toJSON(),model,graph,()=>{});
  expect(engine.getHopContext()).toMatchObject({focus_node:{id:'consumer'},analysis_mode:'ct'});
  expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({kind:'column_lineage',traversalSide:'downstream',sourceRefs:[{node:'origin',col:'Discount'}]}));
  const before=JSON.stringify(engine.columnAspect?.edges);
  expect(engine.submitFindings({focus_node_id:'consumer',verdict:'analyze',summary:'Discount writes to destination',sections:[{angle:'technical',text:'INSERT dbo.destination(Discount) SELECT Discount FROM dbo.origin;'}],column_flow:[{out_col:'Discount',writes_to:{node:'destination',col:'Discount'},upstream_columns:[{node:'origin',col:'Discount'}]}]})).toMatchObject({ok:true});
  expect(JSON.stringify(engine.columnAspect?.edges)).not.toBe(before);
  expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({from_node:'origin',from_col:'Discount',to_node:'destination',to_col:'Discount'}));
  expect(engine.getHopContext()).toMatchObject({done:true});
 });
});

it('carries the explicit local writer alias alongside its reached storage output',()=>{
 const nodes=[makeNode({id:'origin',name:'origin',schema:'dbo',type:'view',columns:[column('Discount')]}),
  makeNode({id:'writer',name:'writer',schema:'dbo',type:'procedure',columns:[column('Discount')],bodyScript:'INSERT dbo.saved(Amount) SELECT Discount FROM dbo.origin;'}),
  makeNode({id:'saved',name:'saved',schema:'dbo',type:'table',columns:[column('Amount')]}),
  makeNode({id:'reader',name:'reader',schema:'dbo',type:'procedure',columns:[column('Discount')],bodyScript:'INSERT #buffer(Discount) EXEC dbo.writer;'})];
 const pairs:Array<[string,string]>=[['origin','writer'],['writer','saved'],['writer','reader']];
 const model=makeModel(nodes,pairs,['dbo']);const graph=makeGraph(nodes,pairs);const engine=new NavigationEngine(model,graph,()=>{},{});
 expect(engine.init({origin:'origin',question:'Trace Discount sources and consumers',direction:'bidirectional',analysisMode:'ct',targetColumns:['Discount'],depthIntent:{upstream:{levels:'all',exactness:'exact'},downstream:{levels:'all',exactness:'exact'}}})).toMatchObject({ok:true});
 engine.getHopContext();expect(engine.submitFindings({focus_node_id:'origin',verdict:'analyze',summary:'Origin produces Discount',sections:[{angle:'technical',text:'Origin output'}],column_flow:[{out_col:'Discount',upstream_columns:[]}]})).toMatchObject({ok:true});
 expect(engine.getHopContext()).toMatchObject({focus_node:{id:'writer'}});
 expect(engine.submitFindings({focus_node_id:'writer',verdict:'analyze',summary:'Discount writes saved Amount',sections:[{angle:'technical',text:'Declared writer mapping'}],column_flow:[{out_col:'Discount',writes_to:{node:'saved',col:'Amount'},upstream_columns:[{node:'origin',col:'Discount'}]}]})).toMatchObject({ok:true});
 expect(engine.getHopContext()).toMatchObject({focus_node:{id:'reader'},analysis_mode:'ct'});
 expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({kind:'column_lineage',traversalSide:'downstream',sourceRefs:expect.arrayContaining([{node:'writer',col:'Discount'},{node:'saved',col:'Amount'}])}));
 expect(engine.submitFindings({focus_node_id:'reader',verdict:'analyze',summary:'Reads writer Discount',sections:[{angle:'technical',text:'Reader of the declared writer alias'}],column_flow:[{out_col:'Discount',upstream_columns:[{node:'writer',col:'Discount'}]}]})).toMatchObject({ok:true});
 expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({from_node:'writer',from_col:'Discount',to_node:'saved',to_col:'Amount'}));
});

it.each([false,true])('honors both explicitly arriving sides at a shared bidirectional writer (restore=%s)',restore=>{
 const nodes=[makeNode({id:'origin',name:'origin',schema:'dbo',type:'view',columns:[column('Discount')],bodyScript:'SELECT Discount FROM dbo.owed;'}),
  makeNode({id:'owed',name:'owed',schema:'dbo',type:'table',columns:[column('Discount')]}),
  makeNode({id:'writer',name:'writer',schema:'dbo',type:'procedure',columns:[],bodyScript:'INSERT dbo.owed(Discount) SELECT Discount FROM dbo.origin; INSERT dbo.other(Discount) SELECT Discount FROM dbo.origin;'}),
  makeNode({id:'other',name:'other',schema:'dbo',type:'table',columns:[column('Discount')]}),
  makeNode({id:'foreign',name:'foreign',schema:'dbo',type:'table',columns:[column('Discount')]})];
 const pairs:Array<[string,string]>=[['owed','origin'],['origin','writer'],['writer','owed'],['writer','other'],['foreign','writer']];
 const model=makeModel(nodes,pairs,['dbo']);const graph=makeGraph(nodes,pairs);let engine=new NavigationEngine(model,graph,()=>{},{});
 expect(engine.init({origin:'origin',question:'Trace Discount sources and consumers',direction:'bidirectional',analysisMode:'ct',targetColumns:['Discount'],depthIntent:{upstream:{levels:'all',exactness:'exact'},downstream:{levels:'all',exactness:'exact'}}})).toMatchObject({ok:true});
 engine.getHopContext();expect(engine.submitFindings({focus_node_id:'origin',verdict:'analyze',summary:'Origin reads owed Discount',sections:[{angle:'technical',text:'SELECT Discount FROM dbo.owed;'}],column_flow:[{out_col:'Discount',upstream_columns:[{node:'owed',col:'Discount'}]}]})).toMatchObject({ok:true});
 if(restore)engine=NavigationEngine.fromJSON(engine.toJSON(),model,graph,()=>{});
 expect(engine.getHopContext()).toMatchObject({focus_node:{id:'writer'}});
 expect(engine.getCurrentTasks()).toEqual(expect.arrayContaining([
  expect.objectContaining({kind:'column_lineage',traversalSide:'upstream',sourceRefs:[{node:'owed',col:'Discount'}]}),
  expect.objectContaining({kind:'column_lineage',traversalSide:'downstream',sourceRefs:[{node:'origin',col:'Discount'}]}),
 ]));
 const beforeEdges=JSON.stringify(engine.columnAspect?.edges);
 expect(engine.submitFindings({focus_node_id:'writer',verdict:'analyze',summary:'An unrelated sibling is not an arriving obligation',sections:[{angle:'technical',text:'Reject an unrelated sibling atomically.'}],column_flow:[
  {out_col:'Discount',writes_to:{node:'owed',col:'Discount'},upstream_columns:[{node:'origin',col:'Discount'}]},
  {out_col:'OtherDiscount',writes_to:{node:'other',col:'Discount'},upstream_columns:[{node:'foreign',col:'Discount'}]},
 ]})).toMatchObject({code:'out_col_not_tracked'});
 expect(JSON.stringify(engine.columnAspect?.edges)).toBe(beforeEdges);
 expect(engine.hopSubmitColumns.outCols).toBeNull();
 expect(submitFindingsSchemaForMode('ct','technical',true,engine.hopSubmitColumns).safeParse({focus_node_id:'writer',verdict:'analyze',summary:'Both real sides',sections:{technical:'Both writes are bound.'},column_flow:[
  {out_col:'Discount',writes_to:{node:'owed',col:'Discount'},upstream_columns:[{node:'origin',col:'Discount'}]},
  {out_col:'ExtraDiscount',writes_to:{node:'other',col:'Discount'},upstream_columns:[{node:'origin',col:'Discount'}]},
 ]}).success).toBe(true);
 expect(engine.submitFindings({focus_node_id:'writer',verdict:'analyze',summary:'Writer persists both destinations from origin',sections:[{angle:'technical',text:'Both explicit writes consume origin Discount.'}],column_flow:[
  {out_col:'Discount',writes_to:{node:'owed',col:'Discount'},upstream_columns:[{node:'origin',col:'Discount'}]},
  {out_col:'ExtraDiscount',writes_to:{node:'other',col:'Discount'},upstream_columns:[{node:'origin',col:'Discount'}]},
 ]})).toMatchObject({ok:true});
 expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({from_node:'origin',from_col:'Discount',to_node:'other',to_col:'Discount'}));
});

it('ends an explicitly terminal downstream input at a mixed-side hop',()=>{
 const nodes=[makeNode({id:'origin',name:'origin',schema:'dbo',type:'view',columns:[column('Discount')]}),
  makeNode({id:'owed',name:'owed',schema:'dbo',type:'table',columns:[column('Discount')]}),
  makeNode({id:'writer',name:'writer',schema:'dbo',type:'procedure',columns:[],bodyScript:'IF EXISTS(SELECT 1 FROM dbo.origin) BEGIN INSERT dbo.owed(Discount) VALUES(0); INSERT dbo.other(Discount) VALUES(0); END;'}),
  makeNode({id:'other',name:'other',schema:'dbo',type:'table',columns:[column('Discount')]}),
  makeNode({id:'reader',name:'reader',schema:'dbo',type:'view',columns:[column('Discount')],bodyScript:'SELECT Discount FROM dbo.other;'})];
 const pairs:Array<[string,string]>=[['owed','origin'],['origin','writer'],['writer','owed'],['writer','other'],['other','reader']];
 const model=makeModel(nodes,pairs,['dbo']);const graph=makeGraph(nodes,pairs);const engine=new NavigationEngine(model,graph,()=>{},{});
 engine.init({origin:'origin',question:'Trace Discount sources and consumers',direction:'bidirectional',analysisMode:'ct',targetColumns:['Discount'],depthIntent:{upstream:{levels:'all',exactness:'exact'},downstream:{levels:'all',exactness:'exact'}}});
 engine.getHopContext();expect(engine.submitFindings({focus_node_id:'origin',verdict:'analyze',summary:'Origin reads owed Discount',sections:[{angle:'technical',text:'Origin reads owed.'}],column_flow:[{out_col:'Discount',upstream_columns:[{node:'owed',col:'Discount'}]}]})).toMatchObject({ok:true});
 expect(engine.getHopContext()).toMatchObject({focus_node:{id:'writer'}});
 expect(engine.getCurrentTasks().filter(task=>task.kind==='column_lineage').map(task=>task.traversalSide).sort()).toEqual(['downstream','upstream']);
 expect(engine.submitFindings({focus_node_id:'writer',verdict:'analyze',summary:'Both outputs are literal zero; input value terminates',sections:[{angle:'technical',text:'The existence test controls rows, not the Discount value; both outputs are literal zero.'}],column_flow:[
  {out_col:'Discount',writes_to:{node:'owed',col:'Discount'},upstream_columns:[]},
  {out_col:'Discount',writes_to:{node:'other',col:'Discount'},upstream_columns:[]},
 ]})).toMatchObject({ok:true});
 expect(engine.getHopContext()).toMatchObject({focus_node:{id:'reader'},analysis_mode:'bb'});
 expect(engine.getCurrentTasks().some(task=>task.kind==='column_lineage')).toBe(false);
});
