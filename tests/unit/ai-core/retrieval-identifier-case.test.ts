/** Retrieval tools keep checked CS object identities distinct while default/explicit CI remains compatible. */
import { describe,expect,it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { getObjectDetail,getScopeBundle,searchObjects } from '../../../src/ai/tools/tools';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
const objects=[{fullName:'[dbo].[CaseTab]',type:'table' as const,columns:[{name:'Upper',type:'int',nullable:'NOT NULL',extra:''}]},{fullName:'[dbo].[casetab]',type:'table' as const,columns:[{name:'lower',type:'int',nullable:'NOT NULL',extra:''}]},{fullName:'[dbo].[Reader]',type:'view' as const}];
const model=(cs?:boolean)=>buildModel(objects,[{sourceName:'[dbo].[Reader]',targetName:'[dbo].[CaseTab]'},{sourceName:'[dbo].[Reader]',targetName:'[dbo].[casetab]'}],objects,undefined,true,undefined,cs);
describe('source-authoritative retrieval identifiers',()=>{
 it('gets the exact CS object and refuses guessed schema/object casing',()=>{
  const m=model(true);expect(getObjectDetail(m,'dbo.CaseTab')).toMatchObject({id:'[dbo].[CaseTab]',columns:[{n:'Upper'}]});
  expect(getObjectDetail(m,'dbo.casetab')).toMatchObject({id:'[dbo].[casetab]',columns:[{n:'lower'}]});
  expect(getObjectDetail(m,'DBO.CaseTab')).toMatchObject({code:'not_found'});
 });
 it('BFS returns both exact CS twins and their real edges',()=>{
  const m=model(true),graph=buildGraphologyGraph(m);const r=getScopeBundle(m,graph,{origin:'dbo.Reader',direction:'upstream',depth:1,include_ddl:false},DEFAULT_TURN_TOKEN_BUDGET);
  expect(r).toMatchObject({origin:'[dbo].[Reader]'});
  expect((r as any).nodes.map((node:any)=>node.id).sort()).toEqual(['[dbo].[CaseTab]','[dbo].[Reader]','[dbo].[casetab]'].sort());
  expect((r as any).edges).toHaveLength(2);
  expect(getScopeBundle(m,graph,{origin:'dbo.reader',direction:'upstream',depth:1},DEFAULT_TURN_TOKEN_BUDGET)).toMatchObject({code:'not_found'});
 });
 it('exact-name match resolves CS spelling without fuzzy-search ambiguity',async()=>{
  expect(await searchObjects(model(true),'CaseTab')).toMatchObject({name_match:{status:'unique',ids:['[dbo].[CaseTab]']}});
  expect(await searchObjects(model(true),'CASETAB')).not.toHaveProperty('name_match');
 });
 it('checked CS schema filters and visibility do not fold schema twins',async()=>{
  const m=buildModel([{fullName:'[Sales].[Orders]',type:'table'},{fullName:'[sales].[Orders]',type:'table'}],[],undefined,undefined,true,undefined,true);
  expect(await searchObjects(m,'*',undefined,['Sales'],'substring',{schemas:['Sales']} as any)).toMatchObject({total:1,results:[{id:'[Sales].[Orders]',in_user_filter:true}],filter_context:{visible_node_count:1}});
 });
 it.each([undefined,false])('default/explicit CI detail, scope and exact-name resolution remain compatible (%s)',async flag=>{
  const m=model(flag);expect(getObjectDetail(m,'DBO.CASETAB')).toMatchObject({id:'[dbo].[casetab]'});
  expect(getScopeBundle(m,buildGraphologyGraph(m),{origin:'DBO.READER',direction:'upstream',depth:1},DEFAULT_TURN_TOKEN_BUDGET)).toMatchObject({origin:'[dbo].[reader]',nodes:expect.arrayContaining([expect.objectContaining({id:'[dbo].[casetab]'})])});
  expect(await searchObjects(m,'*',undefined,['DBO'])).toMatchObject({total:2});
  expect(await searchObjects(m,'CASETAB')).toMatchObject({name_match:{status:'unique',ids:['[dbo].[casetab]']}});
 });
});
