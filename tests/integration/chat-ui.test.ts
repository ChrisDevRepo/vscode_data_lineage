/// <reference lib="dom" />
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  stateMachine: {
    deferredQuestions: unknown;
    columnAspect: {edges:Array<{hop_node:string;from_node:string;from_col:string;to_node:string;to_col:string;transforms?:string[]}>} | null;
    getResult(): unknown;
    toJSON(): unknown;
  } | null;
}
import { chromium, type Browser, type Page, type Locator } from 'playwright-core';

/** Opt-in Playwright test of native chat controls in a real isolated Electron host. */
suite('Native chat confirmations — actual UI', () => {
  let browser: Browser;
  let page: Page;
  let exports: {getSession(): SessionProjection};
  const real = process.env.DLV_CHAT_UI_REAL === '1';
  const phaseTimeoutMs = real ? Number(process.env.AI_TEST_TIMEOUT_MS) : 180000;
  let testDeadline = Number.POSITIVE_INFINITY;
  const remainingWait = (timeout: number) => {
    const remaining = Math.min(timeout, testDeadline - Date.now());
    assert.ok(remaining > 0, 'native chat test exceeded AI_TEST_TIMEOUT_MS');
    return remaining;
  };
  const catalogPath = [
    join(__dirname, '..', 'cases', 'loadCases.cjs'),
    join(__dirname, '..', '..', '..', '..', 'tests', 'cases', 'loadCases.cjs'),
  ].find(path => existsSync(path));
  if (!catalogPath) throw new Error('tests/cases/loadCases.cjs was not found from the chat-ui test.');
  const fixtureTrace = (createRequire(catalogPath)(catalogPath) as {
    loadCases: (runner?: string) => Array<{ id: string; prompt?: string; expect?: { phase?: string } }>;
  }).loadCases('electron').find(row => row.id === 'electron-fixture-trace');
  if (!fixtureTrace?.prompt || !fixtureTrace.expect?.phase) {
    throw new Error('electron-fixture-trace needs a prompt and expect.phase in tests/cases/lineage-cases.yaml');
  }
  const fixturePrompt = fixtureTrace.prompt;
  const planPhase = fixtureTrace.expect.phase;
  const originalQuestion = 'Trace all dependencies upstream from  [ai].[spImportOrders]  all level up and one level down';
  const artifactDir = `tmp/chat-ui/${real ? 'live' : 'fixture'}`;
  let metricsRoot: string;
  let tracePath: string | undefined;
  let traceOffset = 0;
  let testIndex = 0;
  let casePrompts: string[] = [];
  let initialGraph: SessionProjection['resultGraph'];
  let initialAnswer: string | null = null;
  let extensionPath: string;
  let fixture: { uiRequests: Array<{messages:unknown;tools:Array<{name:string}>}>;
    uiErrors: Array<{requestIndex:number;message:string}> };
  let firstErrorIndex = 0;
  let assertUiProviderHealthy: (errors: Array<{requestIndex:number;message:string}>, firstErrorIndex:number) => void;
  const assertProviderHealthy = () => {
    if (!real || !fixture) return;
    assertUiProviderHealthy(fixture.uiErrors, firstErrorIndex);
  };
  const deadlineWait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now()+remainingWait(real ? phaseTimeoutMs : 20000);
    while (!predicate() && Date.now()<deadline) {
      assertProviderHealthy();
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assertProviderHealthy();
    assert.ok(predicate(), label);
  };
  const waitForControl = async (locator: Locator, timeout = phaseTimeoutMs) => {
    if (!real) return locator.waitFor({state:'visible',timeout});
    timeout = remainingWait(timeout);
    const deadline = Date.now()+timeout;
    while (!await locator.isVisible() && Date.now()<deadline) {
      assertProviderHealthy();
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assertProviderHealthy();
    await locator.waitFor({state:'visible',timeout:Math.max(1,deadline-Date.now())});
  };
  const input = () => page.locator('.interactive-session [role="textbox"]').last();
  const idleInput = async () => {
    await waitForControl(page.getByRole('button',{name:/^Send \[/}).last(),real ? phaseTimeoutMs : 20000);
  };
  const send = async (text: string) => {
    await idleInput();
    const before=fixture.uiRequests.length;
    firstErrorIndex=fixture.uiErrors.length;
    const box = input();
    await waitForControl(box,real ? phaseTimeoutMs : 20000);
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
    },text,{timeout:remainingWait(5000)});
    await page.keyboard.press('Escape');
    assert.equal(await box.evaluate(el=>el instanceof HTMLTextAreaElement ? el.value : el.textContent),text,'the real input must contain exactly the user message');
    await page.keyboard.press('Enter');
    casePrompts.push(text);
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
  const captureCompletedResult = (name:string) => {
    const machine = exports.getSession().stateMachine;
    assert.ok(machine,'a completed trace must retain its state machine');
    mkdirSync(artifactDir,{recursive:true});
    writeFileSync(`${artifactDir}/${name}-sm-state.json`,JSON.stringify(machine.toJSON(),null,2));
    writeFileSync(`${artifactDir}/${name}-result.json`,JSON.stringify(machine.getResult(),null,2));
  };
  const newChat = async () => {
    firstErrorIndex=fixture.uiErrors.length;
    await idleInput();
    await page.getByRole('button',{name:/^New Chat \(/}).click();
    await idleInput();
  };
  const openPlan = async () => {
    await newChat();
    await send(real ? `@lineage /trace ${originalQuestion}` : fixturePrompt);
    await idleInput();
    assertProviderHealthy();
    assert.equal(exports.getSession().phase.kind,planPhase);
    await waitForControl(continueButton());
    assert.equal(exports.getSession().memory.getResult().detail_slots.length,0,'plan cannot run before approval');
    await waitForControl(changeScopeButton(),real ? phaseTimeoutMs : 20000);
    await waitForControl(cancelButton(),real ? phaseTimeoutMs : 20000);
  };

  setup(async () => {
    casePrompts = [];
    testIndex += 1;
    traceOffset = tracePath && existsSync(tracePath) ? readFileSync(tracePath).length : 0;
    initialGraph = exports?.getSession().resultGraph;
    initialAnswer = page && await responses().count() ? await responses().last().innerText().catch(() => null) : null;
    testDeadline = real ? Date.now() + phaseTimeoutMs : Number.POSITIVE_INFINITY;
  });
  const persistMetrics = async (catalogId: string, outcome: string) => {
    if (!real || !metricsRoot) return;
    const caseDir = join(metricsRoot, `case-${testIndex}`);
    mkdirSync(caseDir, { recursive: true });
    // Drain observed lifecycle records after cancellation without waiting for inference.
    let trace = '';
    let records: Array<{type?: string; requestId?: string}> = [];
    const drainDeadline = Date.now() + 2000;
    do {
      trace = tracePath && existsSync(tracePath) ? readFileSync(tracePath).subarray(traceOffset).toString('utf8') : '';
      records = trace.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const ended = new Set(records.filter(row => row.type === 'turn-terminal').map(row => row.requestId));
      if (!records.some(row => row.type === 'turn-start' && !ended.has(row.requestId))) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < drainDeadline);
    const caseTracePath = join(caseDir, 'trace.ndjson');
    writeFileSync(caseTracePath, trace);
    const finalSnapshotPath = join(caseDir, 'final-snapshot.json');
    const session = exports?.getSession();
    if (session?.resultGraph && session.resultGraph !== initialGraph) writeFileSync(finalSnapshotPath, JSON.stringify({
      nodes: session.resultGraph.nodeIds, columnEdges: session.stateMachine?.columnAspect?.edges ?? null,
    }, null, 2) + '\n');
    const reportPath = join(caseDir, 'report.md');
    if (session?.resultGraph && session.resultGraph !== initialGraph && session.lastPresentResultDescription) {
      writeFileSync(reportPath, session.lastPresentResultDescription);
    }
    const answerPath = join(caseDir, 'answer.txt');
    const observedAnswer = page && await responses().count() ? await responses().last().innerText().catch(() => null) : null;
    if (observedAnswer !== null && observedAnswer !== initialAnswer) {
      const rendered = await responses().last().locator('.rendered-markdown').allTextContents();
      if (rendered.length) writeFileSync(answerPath, rendered.join('\n'));
    }
    const question = casePrompts.length ? JSON.stringify(casePrompts) : null;
    const questionHash = question === null ? null : createHash('sha256').update(question).digest('hex');
    const fixturePath = join(extensionPath, 'tests/fixtures/AdventureWorks2025_AI.dacpac');
    const fixtureHash = existsSync(fixturePath) ? createHash('sha256').update(readFileSync(fixturePath)).digest('hex') : null;
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: extensionPath, encoding: 'utf8' });
    const sourceDiff = spawnSync('git', ['diff', 'HEAD', '--', 'src', 'assets'], { cwd: extensionPath });
    const context = { provider: process.env.AI_TEST_PROVIDER ?? null, model: process.env.AI_TEST_MODEL ?? null,
      reasoningEffort: process.env.AI_TEST_REASONING_EFFORT ?? null,
      executionMode: process.env.DLV_CHAT_UI_REPLAY_TRACE ? 'native-replay' : 'native-live',
      settings: { timeoutMs: phaseTimeoutMs, requestTimeoutMs: Number(process.env.AI_TEST_REQUEST_TIMEOUT_MS) || null, temperature: 0.1 },
      promptAssets: Object.fromEntries(['src/ai/prompting/prompts.ts', 'src/ai/prompting/smPrompts.ts', 'assets/aiOutputTemplates.yaml']
        .map(file => [file, createHash('sha256').update(readFileSync(join(extensionPath, file))).digest('hex')])),
      source: { revision: revision.status === 0 ? revision.stdout.trim() : null,
        trackedSourceDiffHash: sourceDiff.status === 0 ? createHash('sha256').update(sourceDiff.stdout).digest('hex') : null } };
    const manifestPath = join(caseDir, 'metrics-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ catalogId, question, questionHash, fixtureHash, context,
      caseIdentity: questionHash === null || fixtureHash === null ? null : `${catalogId}:${questionHash}:${fixtureHash}`,
      tracePath: caseTracePath, requestIds: [...new Set(records.filter(row => row.type === 'turn-start').map(row => row.requestId).filter(id => typeof id === 'string'))],
      outcome, answerPath, answerRepresentation: 'rendered_text', reportPath, reportRepresentation: 'markdown', finalSnapshotPath,
    }, null, 2) + '\n');
    const metrics = spawnSync(process.execPath, [join(extensionPath, 'tests/tools/trace-metrics.mjs'),
      '--case-manifest', manifestPath, '--output', join(caseDir, 'metrics.json')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', shell: false,
    });
    assert.equal(metrics.status, 0, 'deterministic native case metrics must be persisted');
    console.log(`[chat-ui] metrics=${join(caseDir, 'metrics.json')}`);
  };
  teardown(async function () {
    try {
      // Cancel through the native action so the provider's cancellation token aborts its request.
      if (real && page) await vscode.commands.executeCommand('workbench.action.chat.cancel');
    } finally {
      testDeadline = Number.POSITIVE_INFINITY;
      await persistMetrics(`native:${this.currentTest?.title ?? 'unknown'}`, this.currentTest?.state ?? 'unknown');
    }
  });

  suiteSetup(async function () {
    extensionPath = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz')!.extensionPath;
    if (real) {
      metricsRoot = join(extensionPath, 'test-results', 'chat-ui', randomUUID());
      mkdirSync(metricsRoot, { recursive: true });
    }
    await vscode.workspace.getConfiguration('editor').update('accessibilitySupport','on',vscode.ConfigurationTarget.Global);
    ({ assertUiProviderHealthy } = createRequire(join(extensionPath,'package.json'))(
      join(extensionPath,'tests/tools/chat-ui-replay-trace.mjs'),
    ));
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
      tracePath=await vscode.commands.executeCommand<string>('dataLineageViz.enableAiTraceLogging');
      assert.ok(tracePath,'live acceptance must capture a fresh NDJSON trace');
      console.log(`[chat-ui] trace=${tracePath}`);
    }
    await deadlineWait(()=>!!exports.getSession().model,'public demo must load');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PLAYWRIGHT_CDP_PORT}`);
    page = browser.contexts().flatMap(context=>context.pages()).find(p=>p.url().includes('workbench'))!;
    assert.ok(page,'CDP must attach to the test workbench');
    await vscode.commands.executeCommand('workbench.action.chat.open', {query: fixturePrompt, isPartialQuery: true});
    // Choose the contributed fixture via the real model picker; no provider credentials.
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideToasts');
    await page.locator('.notifications-toasts.visible').waitFor({state:'hidden'});
    const picker = page.getByRole('button', {name:/^Models|Pick Model|Select Model|Model Picker/i}).last();
    await picker.click();
    await page.getByText('Lineage Smoke Model',{exact:true}).last().click();
    await page.keyboard.press('Escape');
  });

  test('Cancel button discards the plan without analyzing; stale Approve is ignored',async()=>{
    await openPlan();
    const before=fixture.uiRequests.length;
    await cancelButton().click();
    await page.getByText('Exploration cancelled.',{exact:true}).last().waitFor({timeout:remainingWait(20000)});
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
      await new Promise(resolve=>setTimeout(resolve,remainingWait(100)));
    }
    await capture('cancel-button');
  });

  for(const reply of ['no','stop','no stop']) test(`typed "${reply}" cancels without clicking a button`,async()=>{
    await openPlan();
    const before=fixture.uiRequests.length;
    await send(`@lineage ${reply}`);
    await page.getByText('Exploration cancelled.',{exact:true}).last().waitFor({timeout:remainingWait(phaseTimeoutMs)});
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
    assertProviderHealthy();
    assert.equal(exports.getSession().phase.kind,planPhase);
    assert.equal(exports.getSession().memory.getResult().detail_slots.length,0);
    await waitForControl(continueButton(),real ? phaseTimeoutMs : 20000);
    await waitForControl(changeScopeButton(),real ? phaseTimeoutMs : 20000);
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
    captureCompletedResult('typed-approve');
    await capture('typed-approve');
  });
  suiteTeardown(async()=>{
    if (real && testIndex === 0) await persistMetrics('native:suite-setup', 'failed');
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
    await page.getByText('Typed question received and answered.',{exact:false}).last().waitFor({timeout:remainingWait(20000)});
    assert.ok(fixture.uiRequests.length>before,'Enter must actually reach the provider');
    assert.equal(exports.getSession().phase.kind,planPhase,'ordinary question preserves proposal');
    await idleInput();
    await changeScopeButton().click();
    await send('@lineage change scope to one level downstream');
    await idleInput();
    await waitForControl(continueButton(),20000);
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
    await waitForControl(preview);
    await preview.click();
    await waitForControl(page.getByRole('button',{name:/Run trace/}).last());
    await page.getByRole('button',{name:/Run trace/}).last().click();
    await waitForControl(continueButton());
    const session = exports.getSession();
    assert.equal(session.phase.kind,planPhase);
    assert.equal(session.memory.getResult().detail_slots.length,0,'no hop runs before consent');
    await idleInput();
    if(exports.getSession().pendingExploration?.classification!=='both') {
      await changeScopeButton().click();
      await send('@lineage Change the pending plan to both business and technical analysis. Keep all levels upstream and one level downstream.');
      await idleInput();
      await waitForControl(continueButton());
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
    captureCompletedResult('live-trace');
    const suggestion = page.getByRole('button',{name:/What could I explore next/}).last();
    await waitForControl(suggestion);


    const stateBefore=JSON.stringify({phase:session.phase,graph:session.resultGraph,description:session.lastPresentResultDescription,leads:session.stateMachine?.deferredQuestions});
    const callStart=fixture.uiRequests.length;
    const followupStart=Date.now();
    await suggestion.click();
    await deadlineWait(()=>fixture.uiRequests.length>callStart,'follow-up badge must invoke the selected AI model');
    await page.getByText('Would you like me to analyze one of these in detail?',{exact:false}).last().waitFor({state:'visible',timeout:remainingWait(real ? phaseTimeoutMs : 90000)});
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

  // DDL of tests/fixtures/AdventureWorks2025_AI.dacpac: [ai].[spRefreshPrices] is the only writer of [ai].[PriceMaster].[ListPrice]:
  //   ListPrice = sc.CostPrice * (1 + COALESCE(m.MarkupPct, 0.15))  FROM [ai].[SupplierPrices] sp CROSS JOIN [ai].[RegionLookup] r
  //   INNER JOIN [ai].[CurrencyConfig] cc ON sp.Currency = cc.Code WHERE cc.IsBase = 1 ... LEFT JOIN [ai].[MarkupRules] m ON RegionCode.
  // Value input: [ai].[SupplierPrices].[CostPrice] (also MarkupPct). Key/filter-only: [ai].[CurrencyConfig].[Code] (join key) and
  // [ai].[CurrencyConfig].[IsBase] (filter); the procedure comment itself says "CurrencyConfig: FILTER ONLY".
  if (real) test('live column trace → arithmetic and contextual dependencies, rendered report intact',async function () {
    const column = '[ai].[PriceMaster].[ListPrice]';
    const normalized = (text:string|null) => (text ?? '').replace(/[\[\]`]/g,'').toLowerCase();
    await newChat();
    assert.ok(exports.getSession().model?.nodes.some(node=>node.id.toLowerCase()==='[ai].[pricemaster]'),'the real fixture must contain the traced table');
    await send(`@lineage /trace ${column} — trace this column back to its original sources.`);
    await waitForControl(continueButton().or(page.getByRole('button',{name:/Show graph preview/}).last()));
    if (!await continueButton().isVisible()) {
      await page.getByRole('button',{name:/Show graph preview/}).last().click();
      await waitForControl(page.getByRole('button',{name:/Run trace/}).last());
      await page.getByRole('button',{name:/Run trace/}).last().click();
      await waitForControl(continueButton());
    }
    assertProviderHealthy();
    assert.equal(exports.getSession().phase.kind,planPhase);
    assert.equal(exports.getSession().memory.getResult().detail_slots.length,0,'no hop runs before consent');
    await idleInput();
    await approveOnce();
    await deadlineWait(()=>exports.getSession().phase.kind==='completed','approved column trace must complete');
    captureCompletedResult('column-trace');
    const fullReport = page.getByRole('button',{name:/Show (the )?full description/}).last();
    await waitForControl(fullReport);
    await fullReport.click();
    await idleInput();
    const reply = responses().last();
    const chainHeading = reply.locator('.rendered-markdown').locator('h1,h2,h3,h4,h5,h6').filter({hasText:/^\s*Column Chain\s*$/i});
    await chainHeading.first().waitFor({state:'visible',timeout:remainingWait(60000)});
    const reportText = await reply.innerText();
    mkdirSync(artifactDir,{recursive:true});
    writeFileSync(`${artifactDir}/column-report.txt`,reportText);
    await reply.scrollIntoViewIfNeeded();
    await capture('column-trace');
    // Source rows of the Column Chain: table rows between its heading and the next h1/h2 section, first cell = source column.
    const chainSources = await reply.evaluate(root=>{
      const nodes=Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,tr'));
      const start=nodes.findIndex(n=>/^H\d$/.test(n.tagName) && /^\s*column chain\s*$/i.test(n.textContent ?? ''));
      const rows:string[]=[];
      for (const n of nodes.slice(start+1)) {
        if (/^H[12]$/.test(n.tagName)) break;
        if (n.tagName==='TR' && n.querySelector('td')) rows.push(n.querySelector('td')?.textContent ?? '');
      }
      return rows;
    });
    const sources = chainSources.map(normalized);
    assert.ok(sources.some(row=>row.includes('costprice')),`Column Chain must list the value input CostPrice; rows: ${JSON.stringify(chainSources)}`);
    assert.ok(sources.some(row=>row.includes('markuppct')),`Column Chain must list the value input MarkupPct; rows: ${JSON.stringify(chainSources)}`);
    assert.match(normalized(reportText),/currencyconfig/,'the join/filter object stays in the report');
    const aspect = exports.getSession().stateMachine?.columnAspect;
    assert.ok(aspect,'the completed column trace must retain its column edges');
    const pricingInputs = aspect.edges.filter(edge=>
      normalized(edge.hop_node)==='ai.sprefreshprices'
      && normalized(edge.to_node)==='ai.pricemaster'
      && normalized(edge.to_col)==='listprice'
      && normalized(edge.from_node)!=='ai.sprefreshprices',
    );
    const arithmeticSources = ['ai.supplierprices.costprice','ai.markuprules.markuppct'];
    // Supplied SQL uses these additional columns to select source rows, markup rules or MERGE targets.
    // Those effects may appear as CT dependencies or in the report; they are not arithmetic operands.
    const contextualSources = [
      'ai.supplierprices.currency','ai.currencyconfig.code','ai.currencyconfig.isbase',
      'ai.supplierprices.effectiveto','ai.markuprules.validto','ai.markuprules.regioncode',
      'ai.regionlookup.regioncode','ai.supplierprices.productcode','ai.supplierprices.effectivefrom',
    ];
    for (const edge of pricingInputs) {
      const source = `${normalized(edge.from_node)}.${normalized(edge.from_col)}`;
      assert.ok(arithmeticSources.includes(source) || contextualSources.includes(source),
        `ListPrice dependency must occur in the supplied pricing SQL: ${source}`);
      if (contextualSources.includes(source)) {
        assert.ok(!edge.transforms?.some(role=>role==='compute' || role==='aggregate'),
          `ListPrice contextual input is not a numeric operand or aggregate: ${source}`);
      }
    }
    for (const source of arithmeticSources) {
      assert.ok(pricingInputs.some(edge=>
        `${normalized(edge.from_node)}.${normalized(edge.from_col)}`===source && edge.transforms?.includes('compute')),
      `ListPrice must retain its arithmetic operand with compute role: ${source}`);
    }
    assert.ok(!(await reply.locator('.rendered-markdown').allInnerTexts()).join('\n').includes('```'),'no literal code fence may render as text');
    const listStarts = await reply.locator('.rendered-markdown ol').evaluateAll(lists=>lists.map(list=>list.getAttribute('start') ?? '1'));
    assert.deepEqual(listStarts.filter(start=>start!=='1'),[],'an ordered list that restarts above 1 was split by an interrupting block');
    for (const line of (exports.getSession().lastPresentResultDescription ?? '').split('\n')) {
      assert.ok(!line.includes('```') || /^\s*```/.test(line),`an SQL fence must stand on its own line: ${line.slice(0,120)}`);
    }
  });

});
