/** Unresolved foreign column demand remains qualified CT until the receiving SQL accounts for it. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
const column=(name:string)=>({name,type:'int',nullable:'NULL' as const,extra:''});

function world(caseSensitive:boolean) {
  const nodes=[makeNode({id:'origin',name:'origin',schema:'dbo',type:'view',columns:[column('Net')]}),
    makeNode({id:'carrier',name:'carrier',schema:'dbo',type:'table',columns:[column('Raw')]}),
    makeNode({id:'producer',name:'producer',schema:'dbo',type:'view',columns:[column('Net')],bodyScript:'SELECT Input AS Net FROM dbo.source;'}),
    makeNode({id:'source',name:'source',schema:'dbo',type:'table',columns:[column('Input')]}),
    makeNode({id:'below',name:'below',schema:'dbo',type:'view',columns:[column('Input')]})];
  const pairs:Array<[string,string]>=[['carrier','origin'],['producer','carrier'],['source','producer'],['below','source']];
  const model={...makeModel(nodes,pairs,['dbo']),identifierCaseSensitive:caseSensitive};const graph=makeGraph(nodes,pairs);
  const engine=new NavigationEngine(model,graph,()=>{},{});
  expect(engine.init({origin:'origin',question:'Trace Net',direction:'upstream',analysisMode:'ct',targetColumns:['Net'],
    depthIntent:{upstream:{levels:'all',exactness:'exact'},downstream:{levels:0,exactness:'exact'}}})).toMatchObject({ok:true});
  engine.getHopContext();
  expect(engine.submitFindings({focus_node_id:'origin',verdict:'analyze',summary:'Net comes from stored Raw',sections:[{angle:'technical',text:'Origin input'}],
    column_flow:[{out_col:'Net',upstream_columns:[{node:'carrier',col:'Raw'}]}]})).toMatchObject({ok:true});
  return {engine,model,graph};
}

describe('source-qualified unresolved CT arrival',()=>{
  for(const caseSensitive of [false,true])for(const restore of [false,true])it(`preserves Raw without inventing a producer output (CS=${caseSensitive},restore=${restore})`,()=>{
    const w=world(caseSensitive);let engine=w.engine;
    if(restore)engine=NavigationEngine.fromJSON(engine.toJSON(),w.model,w.graph,()=>{});
    expect(engine.getHopContext()).toMatchObject({focus_node:{id:'producer',bb_ddl:'SELECT Input AS Net FROM dbo.source;'},analysis_mode:'ct'});
    expect(engine.columnAspect?.active_columns).toEqual(['Raw']);
    expect(engine.getCurrentTasks()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'column_lineage',sourceRefs:[{node:'carrier',col:'Raw'}]})]));
    expect(engine.hopSubmitColumns.outCols).toEqual([]);
    const saved=engine.toJSON();expect(()=>NavigationEngine.fromJSON(saved,w.model,w.graph,()=>{})).not.toThrow();
    if(restore)engine=NavigationEngine.fromJSON(saved,w.model,w.graph,()=>{});
    const finding={focus_node_id:'producer',verdict:'passthrough' as const,summary:'Raw is not a local output',sections:[{angle:'technical' as const,text:'Net is the only declared output'}],column_flow:[]};
    expect(submitFindingsSchemaForMode('ct','technical',true,engine.hopSubmitColumns).safeParse({...finding,sections:{technical:'Net is the only declared output'}}).success).toBe(true);
    expect(submitFindingsSchemaForMode('ct','technical',true,engine.hopSubmitColumns).safeParse({...finding,sections:{technical:'Net is the only declared output'},column_flow:[{out_col:'Raw',upstream_columns:[]}]}).success).toBe(false);
    expect(submitFindingsSchemaForMode('ct','technical',true,engine.hopSubmitColumns).safeParse({...finding,sections:{technical:'Net is the only declared output'},column_flow:[{out_col:'Net',upstream_columns:[]}]}).success).toBe(false);
    expect(engine.submitFindings(finding)).toMatchObject({ok:true});
    expect(engine.columnAspect?.edges.some(edge=>edge.from_node==='producer'||edge.to_node==='producer')).toBe(false);
    if(restore)engine=NavigationEngine.fromJSON(engine.toJSON(),w.model,w.graph,()=>{});
    expect(engine.getHopContext()).toMatchObject({focus_node:{id:'below'},analysis_mode:'bb'});
  });
});
