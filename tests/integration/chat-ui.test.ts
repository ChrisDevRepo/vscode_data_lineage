/// <reference lib="dom" />
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveLangfuseConfig } from '../harness/langfuseExport';
import { copyNativeHostLog, exportNativeEvidence } from '../harness/nativeEvidence';
import { parseTrace } from '../harness/traceModel';
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
  const artifactDir = `tmp/chat-ui/${real ? 'live' : 'fixture'}`;
  const copyHostLog = (destination = artifactDir) => {
    try { copyNativeHostLog(process.env.DLV_CHAT_UI_PROFILE, destination); }
    catch { /* Fixture evidence is best effort; real runs validate the saved log during export. */ }
  };
  let metricsRoot: string;
  let tracePath: string | undefined;
  let traceOffset = 0;
  let testIndex = 0;
  let casePrompts: string[] = [];
  const capturedStates = new Map<string, string>();
  let captureFailed = false;
  let initialGraph: SessionProjection['resultGraph'];
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
    await captureTurnStates();
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
  const approveOnce = async () => { await idleInput(); await continueButton().click(); };
  const renderedPlan = () => {
    const revision = exports?.getSession().pendingExploration?.revision;
    return revision && revision > 1
      ? responses().filter({ has: page.getByRole('heading', { name: `Exploration plan · revision ${revision}`, exact: true }) })
      : page;
  };
  const continueButton = () => renderedPlan().getByRole('button',{name:/Approve & Proceed/}).last();
  const changeScopeButton = () => renderedPlan().getByRole('button',{name:/Change scope/}).last();
  const cancelButton = () => renderedPlan().getByRole('button',{name:/Cancel$/}).last();
  const responses = () => page.locator('.interactive-session .interactive-response');
  const capture = async (name:string) => {
    mkdirSync(artifactDir,{recursive:true});
    writeFileSync(`${artifactDir}/${name}.txt`,await page.locator('.interactive-session').last().innerText());
    await page.screenshot({path:`${artifactDir}/${name}.png`});
    copyHostLog();
  };
  const captureCompletedResult = (name:string) => {
    const machine = exports.getSession().stateMachine;
    assert.ok(machine,'a completed trace must retain its state machine');
    mkdirSync(artifactDir,{recursive:true});
    writeFileSync(`${artifactDir}/${name}-sm-state.json`,JSON.stringify(machine.toJSON(),null,2));
    writeFileSync(`${artifactDir}/${name}-result.json`,JSON.stringify(machine.getResult(),null,2));
    copyHostLog();
  };
  const newChat = async () => {
    firstErrorIndex=fixture.uiErrors.length;
    await idleInput();
    await page.getByRole('button',{name:/^New Chat \(/}).click();
    await idleInput();
  };
  const openPlan = async () => {
    await newChat();
    await send(fixturePrompt);
    await idleInput();
    assertProviderHealthy();
    assert.equal(exports.getSession().phase.kind,planPhase);
    await waitForControl(continueButton());
    assert.equal(exports.getSession().memory.getResult().detail_slots.length,0,'plan cannot run before approval');
    await waitForControl(changeScopeButton(),real ? phaseTimeoutMs : 20000);
    await waitForControl(cancelButton(),real ? phaseTimeoutMs : 20000);
  };

  setup(async () => {
    assert.ok(!captureFailed, 'native evidence capture failed; stop before another model call');
    casePrompts = [];
    capturedStates.clear();
    testIndex += 1;
    traceOffset = tracePath && existsSync(tracePath) ? readFileSync(tracePath).length : 0;
    initialGraph = exports?.getSession().resultGraph;
    testDeadline = real ? Date.now() + phaseTimeoutMs : Number.POSITIVE_INFINITY;
  });
  const readCaseTrace = () => tracePath && existsSync(tracePath)
    ? readFileSync(tracePath).subarray(traceOffset).toString('utf8') : '';
  const captureTurnStates = async () => {
    if (!real || !metricsRoot) return;
    let trace = readCaseTrace();
    let parsed = parseTrace(trace);
    const drainDeadline = Date.now() + 2000;
    while (parsed.turns.some(row => row.type === 'turn-start'
      && !parsed.turns.some(end => end.type === 'turn-terminal' && end.requestId === row.requestId))
      && Date.now() < drainDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      trace = readCaseTrace();
      parsed = parseTrace(trace);
    }
    const pending = parsed.turns.filter(row => row.type === 'turn-terminal' && !capturedStates.has(row.requestId));
    assert.ok(pending.length <= 1, 'native turn states were not captured before the next turn; historical states cannot be reconstructed');
    for (const turn of pending) {
      const starts = parsed.turns.filter(row => row.type === 'turn-start');
      const index = starts.findIndex(row => row.requestId === turn.requestId);
      assert.equal(index, starts.length - 1, 'a newer native request started before its predecessor state was captured');
      assert.ok(index >= 0, 'a captured native terminal must have its turn-start');
      const dir = join(metricsRoot, `case-${testIndex}`, `turn-${index + 1}`);
      mkdirSync(dir, { recursive: true });
      const statePath = join(dir, 'sm-state.json');
      const machine = exports?.getSession().stateMachine;
      writeFileSync(statePath, JSON.stringify(machine ? machine.toJSON() : { explorationOpened: false }, null, 2) + '\n');
      capturedStates.set(turn.requestId, statePath);
    }
    return trace;
  };
  const persistMetrics = async (catalogId: string, outcome: string) => {
    if (!real || !metricsRoot) return;
    const captureErrors: string[] = [];
    let trace = readCaseTrace();
    try { trace = await captureTurnStates() ?? trace; }
    catch { captureErrors.push('Native turn states were not captured before the next request; saved evidence is incomplete.'); }
    const caseDir = join(metricsRoot, `case-${testIndex}`);
    mkdirSync(caseDir, { recursive: true });
    const records = parseTrace(trace).turns;
    const caseTracePath = join(caseDir, 'trace.ndjson');
    const opening = tracePath && readFileSync(tracePath, 'utf8').split('\n')[0];
    if (opening) trace = opening + '\n' + trace;
    writeFileSync(caseTracePath, trace);
    copyHostLog(caseDir);
    const lastStatePath = records.filter(row => row.type === 'turn-start')
      .map(turn => capturedStates.get(turn.requestId)).filter((path): path is string => path !== undefined).at(-1);
    if (lastStatePath) copyFileSync(lastStatePath, join(caseDir, 'sm-state.json'));
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
    if (observedAnswer !== null && records.some(row => row.type === 'turn-start')) {
      const rendered = await responses().last().locator('.rendered-markdown').allTextContents();
      if (rendered.length) writeFileSync(answerPath, rendered.join('\n'));
    }
    const question = casePrompts.length ? JSON.stringify(casePrompts) : null;
    const questionHash = question === null ? null : createHash('sha256').update(question).digest('hex');
    const fixturePath = join(extensionPath, 'assets/demo.dacpac');
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
    const metrics = spawnSync(process.execPath, [join(extensionPath, 'tests/tools/lineage-score.mjs'), '--trace',
      '--case-manifest', manifestPath, '--output', join(caseDir, 'metrics.json')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', shell: false,
    });
    console.log(`[chat-ui] metrics=${join(caseDir, 'metrics.json')}`);
    await exportNativeEvidence({ trace, directory: caseDir,
      sessionId: metricsRoot.split(/[\\/]/).pop()!, promptId: catalogId, statePaths: capturedStates, captureErrors });
    assert.equal(metrics.status, 0, 'deterministic native case metrics must be persisted');
  };
  teardown(async function () {
    try {
      // Cancel through the native action so the provider's cancellation token aborts its request.
      if (real && page) await vscode.commands.executeCommand('workbench.action.chat.cancel');
    } finally {
      testDeadline = Number.POSITIVE_INFINITY;
      try { await persistMetrics(`native:${this.currentTest?.title ?? 'unknown'}`, this.currentTest?.state ?? 'unknown'); }
      catch (error) { captureFailed = true; throw error; }
    }
  });

  suiteSetup(async function () {
    extensionPath = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz')!.extensionPath;
    if (real) {
      assert.ok(resolveLangfuseConfig(process.env), 'Set all LANGFUSE_* connection variables before native AI model use.');
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
    await deadlineWait(()=>!!exports.getSession().model,'public demo must finish loading');
    if (real) {
      tracePath=await vscode.commands.executeCommand<string>('dataLineageViz.enableAiTraceLogging', true);
      assert.ok(tracePath,'live acceptance must capture a fresh NDJSON trace');
      console.log(`[chat-ui] trace=${tracePath}`);
    }
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
    copyHostLog();
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
});
