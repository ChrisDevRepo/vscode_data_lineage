import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
vi.mock('vscode', async original => ({ ...await original<object>(), l10n: { t: (text: string) => text }, workspace: { getConfiguration: () => ({ get: () => undefined }) }, StatusBarAlignment: {Left:1}, window:{createStatusBarItem:()=>({show(){},hide(){}})} }));
import { LineageParticipant } from '../../../src/ai/participant/lineageParticipant';
import { AiSession } from '../../../src/ai/session/session';
import { makeModel, makeNode } from '../sm/helpers/fixtures';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';

const PROMPT = 'What could I explore next?';
const ORIGINAL = 'How do refunds affect the net revenue calculation?';
const ANSWER = 'Ask how refund timing changes recognized net revenue; investigate the related refund ledger.';
function fixture() {
  const session = new AiSession();
  session.model = makeModel(['Origin', 'Related'].map(name => makeNode({ id: `[dbo].[${name}]`,schema:'dbo',name,type:'table' })), [['[dbo].[Related]','[dbo].[Origin]']], ['dbo']);
  session.phase = { kind: 'completed' };
  session.memory.setUserQuestion(ORIGINAL);
  session.resultGraph = { nodeIds: ['[dbo].[Origin]'], edges: [], source: 'test', originNodeId: '[dbo].[Origin]' };
  session.stateMachine = { deferredQuestions: [{nodeId:'[dbo].[Deferred]',schema:'dbo',question:'Which discounts apply?',reason:'excluded',atHop:1}] } as unknown as NonNullable<AiSession['stateMachine']>;
  const channel = {info(){},debug(){},warn(){},error(){},trace(){}} as unknown as vscode.LogOutputChannel;
  const runtime = new LineageRuntime({getSession:()=>session,createRegistry:(lease,model)=>buildAiToolRegistry(()=>session,channel,()=>undefined,lease,{model})});
  const participant = new LineageParticipant({ subscriptions: [] } as unknown as vscode.ExtensionContext,()=>session,channel,runtime);
  return { session, participant };
}
describe('AI-authored suggestion follow-up', () => {
  it('offers one natural request without exposing authoring instructions', () => {
    const { participant } = fixture();
    expect((participant as unknown as { followups(): vscode.ChatFollowup[] }).followups()).toEqual([{prompt:PROMPT,label:'Next questions and related objects'}]);
  });
  it('routes the badge through the selected native model with the original intent and deferred leads, preserving analysis', async () => {
    const { participant, session } = fixture();
    const before = JSON.stringify({phase:session.phase,graph:session.resultGraph,leads:session.stateMachine?.deferredQuestions,question:session.memory.getUserQuestion()});
    const requests: vscode.LanguageModelChatMessage[][] = [];
    const model = {id:'selected-test-model',name:'Selected test',vendor:'test',family:'test',version:'1',maxInputTokens:128000,countTokens:async()=>1,sendRequest:vi.fn(async (messages:vscode.LanguageModelChatMessage[])=>{requests.push(messages);return {stream:(async function*(){yield new vscode.LanguageModelTextPart(ANSWER);})()};})} as unknown as vscode.LanguageModelChat;
    const text:string[]=[];
    const result=await participant.handleChatRequest({prompt:PROMPT,model} as vscode.ChatRequest,{history:[]},{markdown:(x:string)=>text.push(x),progress(){}} as unknown as vscode.ChatResponseStream,{isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})} as vscode.CancellationToken);
    expect(result.errorDetails).toBeUndefined();
    expect(model.sendRequest).toHaveBeenCalledOnce();
    expect(result.metadata?.modelCalls).toBe(1);
    const delivered=JSON.stringify(requests);
    expect(delivered).toContain(ORIGINAL);
    expect(delivered).toContain('Which discounts apply?');
    expect(delivered).toContain('Author the suggestions yourself');
    expect(delivered).toContain('Do not start or supplement an exploration');
    expect(delivered).toContain('No title, headings, introduction, recap or analysis');
    expect(delivered).toContain('3–5 short bullet points');
    expect(text.join('')).toContain(ANSWER);
    expect(text.join('')).not.toContain('What does this connected object contribute?');
    expect(JSON.stringify({phase:session.phase,graph:session.resultGraph,leads:session.stateMachine?.deferredQuestions,question:session.memory.getUserQuestion()})).toBe(before);
  });
});
