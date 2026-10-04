/// <reference lib="dom" />
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
interface DepthProjection {
  upstream:{levels:number|'all';exactness:'exact'|'approximate'};
  downstream:{levels:number|'all';exactness:'exact'|'approximate'};
}
interface SessionProjection {
  model: {nodes:Array<{id:string}>} | null; phase: {kind:string}; resultGraph: {nodeIds:string[]} | null;
  memory: {getResult(): {detail_slots: unknown[]}};
  pendingExploration: {revision:number; init:{depthIntent:DepthProjection}; classification:'business'|'technical'|'both'; summary:{scopeCount:number}} | null;
  lastPresentResultDescription: string | null;
  stateMachine: {deferredQuestions: unknown} | null;
}
import { chromium, type Browser, type Page } from 'playwright-core';

/** Opt-in Playwright test of native chat controls in a real isolated Electron host. */
suite('Native chat confirmations — actual UI', () => {
  let browser: Browser;
  let page: Page;
  let exports: {getSession(): SessionProjection};
  const real = process.env.DLV_CHAT_UI_REAL === '1';
  const originalQuestion = 'Trace all dependencies upstream from  [ai].[spImportOrders]  all level up and one level down';
  const artifactDir = `tmp/chat-ui/${real ? 'live' : 'fixture'}`;
  let fixture: { uiRequests: Array<{messages:unknown;tools:Array<{name:string}>}> };
  const deadlineWait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now()+(real ? 600000 : 20000);
    while (!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(predicate(), label);
  };
  const input = () => page.locator('.interactive-session [role="textbox"]').last();
  const idleInput = async () => {
    await page.getByRole('button',{name:/^Send \[/}).last().waitFor({state:'visible',timeout:real ? 300000 : 20000});
  };
  const send = async (text: string) => {
    await idleInput();
    const before=fixture.uiRequests.length;
    const box = input();
    await box.waitFor({state:'visible'});
    assert.notEqual(await box.getAttribute('aria-readonly'),'true','input must accept a typed turn');
    await page.keyboard.press('Escape');
    await page.locator('.interactive-session .monaco-editor').last().click();
    await box.press(process.platform==='darwin' ? 'Meta+A' : 'Control+A');
    // Paste through VS Code's actual editor: CDP key transport drops EditContext spaces.
    await vscode.env.clipboard.writeText(text);
    await box.press(process.platform==='darwin' ? 'Meta+V' : 'Control+V');
    await page.waitForFunction(expected=>{
      const editors=document.querySelectorAll('.interactive-session [role="textbox"]');
      const editor=editors[editors.length-1];
      return (editor instanceof HTMLTextAreaElement ? editor.value : editor?.textContent)===expected;
    },text,{timeout:5000});
    await page.keyboard.press('Escape');
    assert.equal(await box.evaluate(el=>el instanceof HTMLTextAreaElement ? el.value : el.textContent),text,'the real input must contain exactly the user message');
    await page.keyboard.press('Enter');
    await deadlineWait(()=>fixture.uiRequests.length>before,'Enter must dispatch a request to the selected model');
  };
  const approveOnce = async () => { await continueButton().click(); };
  const continueButton = () => page.getByRole('button',{name:/Approve & Proceed/}).last();
  const changeScopeButton = () => page.getByRole('button',{name:/Change scope/}).last();
  const cancelButton = () => page.getByRole('button',{name:/Cancel$/}).last();
  const responses = () => page.locator('.interactive-session .interactive-response');
  const capture = async (name:string) => {
    mkdirSync(artifactDir,{recursive:true});
    writeFileSync(`${artifactDir}/${name}.txt`,await page.locator('.interactive-session').last().innerText());
    await page.screenshot({path:`${artifactDir}/${name}.png`});
  };
  const newChat = async () => {
    await idleInput();
    await page.getByRole('button',{name:/^New Chat \(/}).click();
    await idleInput();
  };
  const openPlan = async () => {
    await newChat();
    await send(real ? `@lineage /trace ${originalQuestion}` : '@lineage /trace [dbo].[ufnGetProductDealerPrice]');
    await continueButton().waitFor({state:'visible',timeout:180000});
    await idleInput();
    assert.equal(exports.getSession().phase.kind,'awaiting_gate');
    assert.equal(exports.getSession().memory.getResult().detail_slots.length,0,'plan cannot run before approval');
    await changeScopeButton().waitFor({state:'visible'});
    await cancelButton().waitFor({state:'visible'});
  };

  suiteSetup(async function () {
    await vscode.workspace.getConfiguration('editor').update('accessibilitySupport','on',vscode.ConfigurationTarget.Global);
    fixture = await vscode.extensions.getExtension('data-lineage-test.data-lineage-test-model-provider')!.activate();
    assert.ok((await vscode.lm.selectChatModels({vendor:'lineage-test'})).length,'scripted provider must resolve');
    exports = await vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz')!.activate();
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    await deadlineWait(()=>!!exports.getSession().model,'public demo must finish loading before the real fixture');
    if (real) await vscode.commands.executeCommand('dataLineageViz.openExternalProject',vscode.Uri.file(
      join(vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz')!.extensionPath,'tests/fixtures/AdventureWorks2025_AI.dacpac'),
    ));
    if (real) assert.ok(exports.getSession().model?.nodes.some(node=>node.id.toLowerCase()==='[ai].[spimportorders]'),
      'the real fixture must contain the original trace origin');
    if (real) {
      const tracePath=await vscode.commands.executeCommand<string>('dataLineageViz.enableAiTraceLogging');
      assert.ok(tracePath,'live acceptance must capture a fresh NDJSON trace');
      console.log(`[chat-ui] trace=${tracePath}`);
    }
    await deadlineWait(()=>!!exports.getSession().model,'public demo must load');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PLAYWRIGHT_CDP_PORT}`);
    page = browser.contexts().flatMap(context=>context.pages()).find(p=>p.url().includes('workbench'))!;
    assert.ok(page,'CDP must attach to the test workbench');
    await vscode.commands.executeCommand('workbench.action.chat.open', {query:'@lineage /trace [dbo].[ufnGetProductDealerPrice]',isPartialQuery:true});
    // Choose the contributed fixture via the real model picker; no provider credentials.
    await vscode.commands.executeCommand('notifications.clearAll');
    const picker = page.getByRole('button', {name:/^Models|Pick Model|Select Model|Model Picker/i}).last();
    await picker.click();
    await page.getByText('Lineage Smoke Model',{exact:true}).last().click();
    await page.keyboard.press('Escape');
  });

  test('Cancel button discards the plan without analyzing; stale Approve is ignored',async()=>{
    await openPlan();
    const before=fixture.uiRequests.length;
    await cancelButton().click();
    await page.getByText('Exploration cancelled.',{exact:true}).last().waitFor({timeout:20000});
    await idleInput();
    assert.equal(exports.getSession().pendingExploration,null);
    assert.equal(exports.getSession().phase.kind,'idle');
    assert.equal(fixture.uiRequests.length,before,'button cancellation spends no model call');
    await continueButton().click();
    const settleUntil=Date.now()+(real ? 15000 : 1000);
    while (Date.now()<settleUntil) {
      assert.equal(exports.getSession().phase.kind,'idle','stale approval must leave the session idle');
      assert.equal(exports.getSession().pendingExploration,null,'stale approval must not restore a proposal');
      assert.equal(fixture.uiRequests.length,before,'stale approval must not run');
      assert.equal(exports.getSession().memory.getResult().detail_slots.length,0,'stale approval must not start analysis');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    await capture('cancel-button');
  });

  for(const reply of ['no','stop','no stop']) test(`typed "${reply}" cancels without clicking a button`,async()=>{
    await openPlan();
    const before=fixture.uiRequests.length;
    await send(`@lineage ${reply}`);
    await page.getByText('Exploration cancelled.',{exact:true}).last().waitFor({timeout:180000});
    await idleInput();
    assert.ok(fixture.uiRequests.length>before,'typed cancellation must reach AI');
    assert.equal(exports.getSession().pendingExploration,null);
    assert.equal(exports.getSession().phase.kind,'idle');
    assert.equal(exports.getSession().memory.getResult().detail_slots.length,0);
    await capture(`typed-${reply.replace(/ /g,'-')}`);
  });

  test('typed scope change revises the plan without clicking Change scope',async()=>{
    await openPlan();
    await send('@lineage change scope to one level upstream and zero levels downstream');
    await idleInput();
    assert.equal(exports.getSession().pendingExploration?.revision,2);
    assert.deepEqual(exports.getSession().pendingExploration?.init.depthIntent,{
      upstream:{levels:1,exactness:'exact'},downstream:{levels:0,exactness:'exact'},
    },'typed scope change must change the actual depth bounds');
    assert.equal(exports.getSession().phase.kind,'awaiting_gate');
    assert.equal(exports.getSession().memory.getResult().detail_slots.length,0);
    await continueButton().waitFor({state:'visible'});
    await changeScopeButton().waitFor({state:'visible'});
    await cancelButton().click();
    await idleInput();
    await capture('typed-scope-change');
  });

  test('typed approve starts analysis without clicking Approve',async()=>{
    await openPlan();
    const before=fixture.uiRequests.length;
    await send('@lineage approve');
    await deadlineWait(()=>exports.getSession().phase.kind==='completed','typed approve must complete analysis');
    await idleInput();
    assert.ok(fixture.uiRequests.length>before,'typed approval must reach AI');
    assert.equal(exports.getSession().pendingExploration,null);
    assert.ok(exports.getSession().memory.getResult().detail_slots.length>0);
    assert.ok(exports.getSession().lastPresentResultDescription,'typed approval must synthesize a visible result');
    await capture('typed-approve');
  });
  suiteTeardown(async()=>{
    mkdirSync(artifactDir,{recursive:true});
    if (page) {
      writeFileSync(`${artifactDir}/aria.txt`,await page.locator('.interactive-session').last().ariaSnapshot());
      writeFileSync(`${artifactDir}/chat.txt`,await page.locator('.interactive-session').last().innerText());
      await page.screenshot({path:`${artifactDir}/workbench.png`});
    }
    writeFileSync(`${artifactDir}/requests.json`,JSON.stringify(fixture?.uiRequests ?? [],null,2));
    await browser?.close();
  });

  if (!real) test('typing at the plan answers; Change scope revises; Approve hides internal instructions and resumes once',async function () {
    await openPlan();
    const before = fixture.uiRequests.length;
    await send('@lineage What does this procedure do?');
    await page.getByText('Typed question received and answered.',{exact:false}).last().waitFor({timeout:20000});
    assert.ok(fixture.uiRequests.length>before,'Enter must actually reach the provider');
    assert.equal(exports.getSession().phase.kind,'awaiting_gate','ordinary question preserves proposal');
    await idleInput();
    await changeScopeButton().click();
    await send('@lineage change scope to one level downstream');
    await idleInput();
    await continueButton().waitFor({state:'visible',timeout:20000});
    assert.equal(exports.getSession().pendingExploration?.revision,2,'typed scope change revises proposal');
    assert.deepEqual(exports.getSession().pendingExploration?.init.depthIntent,{
      upstream:{levels:0,exactness:'exact'},downstream:{levels:1,exactness:'exact'},
    },'one level downstream must close upstream and open one downstream level');
    await approveOnce();
    await deadlineWait(()=>exports.getSession().phase.kind==='completed','Continue must finish the trace');
    await idleInput();
    assert.ok(exports.getSession().lastPresentResultDescription,'synthesis must commit an actual report');
    const transcript = await page.locator('.interactive-session').innerText();
    assert.doesNotMatch(transcript,/Exploration plan confirmed|Approve exploration plan revision|lineage_confirm_exploration|Opaque request-owned/);
    assert.equal(fixture.uiRequests.slice(before).filter(r=>r.tools.some(t=>t.name==='lineage_submit_findings')).length,1,'one approval starts one bodied hop');
  });

  if (real) test('live AI question → concise follow-up badge',async function () {
    const start = Date.now();
    await newChat();
    await send(`@lineage ${originalQuestion}`);
    console.log('[chat-ui] live question dispatched');
    const preview = page.getByRole('button',{name:/Show graph preview/}).last();
    await preview.waitFor({state:'visible',timeout:180000});
    await preview.click();
    await page.getByRole('button',{name:/Run trace/}).last().waitFor({state:'visible',timeout:180000});
    await page.getByRole('button',{name:/Run trace/}).last().click();
    await continueButton().waitFor({state:'visible',timeout:180000});
    const session = exports.getSession();
    assert.equal(session.phase.kind,'awaiting_gate');
    assert.equal(session.memory.getResult().detail_slots.length,0,'no hop runs before consent');
    await idleInput();
    if(exports.getSession().pendingExploration?.classification!=='both') {
      await changeScopeButton().click();
      await send('@lineage Change the pending plan to both business and technical analysis. Keep all levels upstream and one level downstream.');
      await idleInput();
      await continueButton().waitFor({state:'visible',timeout:180000});
    }
    assert.equal(exports.getSession().pendingExploration?.classification,'both');
    assert.deepEqual(exports.getSession().pendingExploration?.init.depthIntent,{
      upstream:{levels:'all',exactness:'exact'},downstream:{levels:1,exactness:'exact'},
    },'both-angle revision must preserve the requested asymmetric depth');
    assert.equal(exports.getSession().pendingExploration?.summary.scopeCount,8,'approval must cover the original eight-node scope');
    await approveOnce();
    console.log('[chat-ui] Approve clicked with only the visible action label');
    await deadlineWait(()=>exports.getSession().phase.kind==='completed','approved real analysis must complete');
    assert.equal(exports.getSession().resultGraph?.nodeIds.length,8,'the completed graph must retain the approved eight-node scope');
    const suggestion = page.getByRole('button',{name:/What could I explore next/}).last();
    await suggestion.waitFor({state:'visible',timeout:180000});


    const stateBefore=JSON.stringify({phase:session.phase,graph:session.resultGraph,description:session.lastPresentResultDescription,leads:session.stateMachine?.deferredQuestions});
    const callStart=fixture.uiRequests.length;
    const followupStart=Date.now();
    await suggestion.click();
    await deadlineWait(()=>fixture.uiRequests.length>callStart,'follow-up badge must invoke the selected AI model');
    await page.getByText('Would you like me to analyze one of these in detail?',{exact:false}).last().waitFor({state:'visible',timeout:90000});
    await idleInput();
    const reply=responses().last();
    assert.equal(await reply.locator('.rendered-markdown').locator('h1,h2,h3,h4,h5,h6').count(),0,'no decorative title in the answer body');
    const bullets=reply.locator('.rendered-markdown li');
    const bulletText=await bullets.allTextContents();
    assert.ok(bulletText.length>=1 && bulletText.length<=5,'follow-up is a short bullet list');
    for(const bullet of bulletText) {
      assert.match(bullet,/\?/,'each bullet must ask a question');
      assert.ok(bullet.trim().split(/\s+/).length<=45,'each question must be concise');
    }
    const followupText=await reply.innerText();
    assert.ok(followupText.trim().split(/\s+/).length<=230,'no long recap or novel');
    assert.equal(fixture.uiRequests.length-callStart,1,'badge uses one inference call');
    assert.equal(fixture.uiRequests[callStart].tools.length,0,'no analysis tools on suggestion path');
    assert.equal(JSON.stringify({phase:session.phase,graph:session.resultGraph,description:session.lastPresentResultDescription,leads:session.stateMachine?.deferredQuestions}),stateBefore,'suggestions do not mutate the completed result');
    writeFileSync(`${artifactDir}/followup.txt`,followupText);
    assert.doesNotMatch(await page.locator('.interactive-session').innerText(),/Exploration plan confirmed|Approve exploration plan revision|lineage_confirm_exploration|Opaque request-owned/);
    console.log(`[chat-ui] live E2E passed elapsedMs=${Date.now()-start} followupMs=${Date.now()-followupStart} bullets=${bulletText.length}`);
  });

});
