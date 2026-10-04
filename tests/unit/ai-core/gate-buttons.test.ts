import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
const host = vi.hoisted(() => ({ commands: new Map<string, (...args: unknown[]) => unknown>(), execute: vi.fn() }));
vi.mock('vscode', async original => ({ ...await original<object>(),
  commands: {
    registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { host.commands.set(name, handler); return {dispose(){}}; },
    executeCommand: host.execute,
  },
  chat: {createChatParticipant: () => ({onDidReceiveFeedback(){},dispose(){}})},
  workspace: {getConfiguration: () => ({get: () => undefined})},
  StatusBarAlignment: {Left: 1}, window: {createStatusBarItem: () => ({show(){},hide(){}})},
}));
import { LineageParticipant } from '../../../src/ai/participant/lineageParticipant';
import type { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { AiSession } from '../../../src/ai/session/session';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

function fixture() {
  const session = new AiSession();
  session.model = makeModel([makeNode({id:'[dbo].[Origin]',schema:'dbo',name:'Origin',type:'procedure'})],[],['dbo']);
  session.phase = {kind:'awaiting_gate',gate:{gate:'confirm_sm_start',classes:[],nodeIds:[],detail:'Reviewed plan'}};
  session.pendingExploration = {revision:2} as NonNullable<AiSession['pendingExploration']>;
  const run = vi.fn(async (_input: unknown) => ({outcome:'ok',modelCalls:0}));
  const runtime = {run,resumeGate:vi.fn(async()=>false)} as unknown as LineageRuntime;
  const channel = {info(){},debug(){},error(){},warn(){}} as unknown as vscode.LogOutputChannel;
  const participant = new LineageParticipant({subscriptions:[]} as unknown as vscode.ExtensionContext,()=>session,channel,runtime);
  const pending = {gateId:'gate-2',gate:'confirm_sm_start',revision:2,requestId:'raising-turn',classes:['reviewed']};
  (participant as unknown as {pendingGate:unknown}).pendingGate=pending;
  participant.register();
  const token = {isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})} as vscode.CancellationToken;
  const model = {id:'selected',name:'Selected',vendor:'test',family:'test',version:'1',maxInputTokens:128000} as vscode.LanguageModelChat;
  const reply = async (prompt:string) => participant.handleChatRequest({prompt,model} as vscode.ChatRequest,
    {history:[{prompt:'Earlier question'}]} as unknown as vscode.ChatContext,
    {markdown(){},progress(){}} as unknown as vscode.ChatResponseStream,token);
  const click = (gateId:string,action:string) => host.commands.get('dataLineageViz.aiResumeNativeGate')!(gateId,action);
  return {session,runtime,run,reply,click,participant};
}

describe('native plan buttons',()=>{
  it('keeps all three controls on an ordinary answer while the plan remains pending',()=>{
    const {participant,session}=fixture();
    const button=vi.fn();
    const writer=participant as unknown as {writeEvent(event:unknown,stream:unknown,prompt:string,requestId:string):void};
    writer.writeEvent({type:'terminal',status:'ok'},{button},'Explain the procedure','answer-turn');
    expect(button.mock.calls.map(call=>call[0].arguments[1])).toEqual(['approve','change','cancel']);
    button.mockClear();
    session.pendingExploration=null;
    session.phase={kind:'idle'};
    writer.writeEvent({type:'terminal',status:'ok'},{button},'Explain the procedure','answer-turn');
    expect(button).not.toHaveBeenCalled();
  });
  for(const [action,label] of [['approve','Approve & Proceed'],['cancel','Cancel']]) {
    it(`${action} submits only the action label and retains the reviewed revision in the host`,async()=>{
      const {reply,click,run,runtime}=fixture();
      host.execute.mockImplementation(async (_command,options)=>{ await reply(options.query.replace('@lineage ','')); });
      await click('gate-2',action);
      expect(host.execute).toHaveBeenLastCalledWith('workbench.action.chat.open',{query:`@lineage ${label}`,blockOnResponse:true});
      expect(run.mock.calls[0]?.[0]).toMatchObject({request:{prompt:`${action==='approve'?'Approve':'Cancel'} exploration plan revision 2`}});
      expect(runtime.resumeGate).toHaveBeenCalledWith('gate-2',action==='approve'?{kind:'approve',classes:['reviewed']}:{kind:'cancel'});
    });
  }

  it('Change scope opens editable chat without submitting a request or approving',async()=>{
    const {click,run,runtime}=fixture();
    host.execute.mockResolvedValue(undefined);
    await click('gate-2','change');
    expect(host.execute).toHaveBeenLastCalledWith('workbench.action.chat.open',{query:'@lineage ',isPartialQuery:true});
    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-2',{kind:'hold'});
    expect(run).not.toHaveBeenCalled();
  });

  it('typed approval has no button authority and stays on the AI-classified path',async()=>{
    const {reply,run}=fixture();
    await reply('approve');
    expect(run.mock.calls[0]?.[0]).toMatchObject({request:{prompt:'approve'}});
  });

  it('rejects stale, malformed and duplicate clicks',async()=>{
    const {click,session,runtime,reply,run}=fixture();
    host.execute.mockClear();
    await click('old-gate','approve');
    await click('gate-2','unexpected');
    session.pendingExploration={...session.pendingExploration!,revision:3};
    await click('gate-2','approve');
    expect(runtime.resumeGate).not.toHaveBeenCalled();
    expect(host.execute).not.toHaveBeenCalled();
    session.pendingExploration={...session.pendingExploration!,revision:2};
    host.execute.mockImplementation(async (_command,options)=>{
      await click('gate-2','approve');
      await reply(options.query.replace('@lineage ',''));
      await click('gate-2','approve');
    });
    await click('gate-2','approve');
    expect(host.execute).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });
});
