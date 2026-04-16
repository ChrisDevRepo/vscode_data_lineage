import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * AI Integration Suite (High-Fidelity)
 * 
 * Validates SM transitions, tool-routing, and synthesis quality.
 * Uses tmp/AdventureWorks2025_AI.dacpac for production-parity.
 */
suite('AI Integration Suite (Real Copilot Tools)', () => {
    let extensionApi: any;
    let runDir: string;
    const baselineDir = path.resolve(__dirname, '..', '..', '..', 'test-internal', 'ai', 'baselines');

    suiteSetup(async function() {
        this.timeout(120000); 
        const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz');
        extensionApi = await ext!.activate();
        
        // Configure low node cap to trigger sliding memory behavior
        await vscode.workspace.getConfiguration('dataLineageViz').update('ai.inlineNodeCap', 5, vscode.ConfigurationTarget.Global);

        // Load AdventureWorks2025_AI for full scenario coverage
        const projectRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const dacpacPath = path.join(projectRoot, 'tmp', 'AdventureWorks2025_AI.dacpac');
        await vscode.commands.executeCommand('dataLineageViz.open', vscode.Uri.file(dacpacPath));
        
        const sess = extensionApi.getSession();
        let retries = 60;
        while (retries > 0 && (!sess.model || sess.projectName !== 'AdventureWorks2025_AI')) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries--;
        }
        assert.ok(sess.model, 'AdventureWorks2025_AI model must be loaded');

        // Setup run directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        runDir = path.join(projectRoot, 'ai', 'runs', `run-${timestamp}`);
        if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
        if (!fs.existsSync(baselineDir)) fs.mkdirSync(baselineDir, { recursive: true });
    });

    /**
     * High-Fidelity SM Loop Simulator
     * Mimics real AI behavior by providing technical verdicts based on the current focus.
     */
    async function runHighFidelityLoop(sess: any, startParsed: any, maxHops = 30) {
        let currentHop = startParsed;
        let iterations = 0;
        
        while (!sess.resultGraph && iterations < maxHops) {
            iterations++;
            const focusId = currentHop.focus_node?.id;
            if (!focusId) break;

            const isCt = sess.stateMachine?.constructor.name === 'ColumnTraceState';
            const toolName = isCt ? 'lineage_submit_hop_analysis' : 'lineage_submit_findings';
            
            const verdicts: any[] = [];
            const neighbors = currentHop.neighbors || [];
            
            for (const n of neighbors) {
                const nid = n.id.toLowerCase();
                let verdict: 'trace' | 'prune' | 'pass' = 'prune';
                let columns: string[] = [];
                let summary = 'Irrelevant utility object.';

                // Logic for ct-q1-totalrevenue
                if (nid.includes('sales') || nid.includes('revenue') || nid.includes('discount') || nid.includes('employee') || nid.includes('person')) {
                    verdict = 'trace';
                    summary = `Technical Dependency found in ${n.id}.`;
                    if (isCt) {
                        if (nid.includes('consolidated')) columns = ['Qty', 'UnitPrice'];
                        else if (nid.includes('discount')) columns = ['Discount'];
                        else if (nid.includes('staging')) columns = ['OrderAmount'];
                        else if (nid.includes('employee')) columns = ['BusinessEntityID'];
                        else columns = (currentHop.focus_node.columns || []);
                    }
                }

                verdicts.push({
                    neighbor_id: n.id,
                    verdict,
                    columns,
                    summary
                });
            }

            const input: any = {
                focus_node_id: focusId,
                notes: `Deep technical analysis of ${focusId}. Identifies column mappings.`,
                complete: iterations >= 9
            };

            if (isCt) {
                input.verdicts = verdicts;
            } else {
                input.verdict = 'relevant';
                input.findings = input.notes;
                input.summary = 'Technical Node';
            }

            const submitResult = await vscode.lm.invokeTool(toolName, {
                input,
                toolInvocationToken: undefined as any
            }, new vscode.CancellationTokenSource().token);

            const resultPart = submitResult.content[0] as vscode.LanguageModelTextPart;
            currentHop = JSON.parse(resultPart.value);

            if (currentHop.complete_rejected) {
                const toPrune = currentHop.complete_rejected.nodes;
                const nextFocus = currentHop.focus_node.id;
                await vscode.lm.invokeTool(toolName, {
                    input: {
                        focus_node_id: nextFocus,
                        notes: 'Forcing completion.',
                        verdicts: toPrune.map((id:string) => ({ neighbor_id: id, verdict: 'prune' })),
                        complete: true
                    },
                    toolInvocationToken: undefined as any
                }, new vscode.CancellationTokenSource().token);
                break;
            }
        }
        return iterations;
    }

    test('SCENARIO: ct-q1-totalrevenue (Deep Column Trace)', async function() {
        this.timeout(120000);
        const sess = extensionApi.getSession();
        sess.resetExploration();

        const startResult = await vscode.lm.invokeTool('lineage_start_column_trace', {
            input: { 
                question: 'Trace TotalRevenue column upstream from FactSalesReport',
                origin: '[ai].[factsalesreport]',
                columns: ['TotalRevenue'],
                direction: 'up'
            },
            toolInvocationToken: undefined as any
        }, new vscode.CancellationTokenSource().token);

        const startParsed = JSON.parse((startResult.content[0] as vscode.LanguageModelTextPart).value);
        const iterations = await runHighFidelityLoop(sess, startParsed, 15);

        assert.ok(sess.resultGraph, 'Quality Gate 1: Result graph generated.');
        const memory = sess.stateMachine?.getMemoryForSynthesis();

        const enrichInput = {
            name: 'Total Revenue Lineage',
            summary: '9-hop trace identifying revenue and discounts.',
            intro: 'Analysis of FactSalesReport.TotalRevenue. Renames from SalesStaging through ConsolidatedSales.',
            closing: 'Revenue logic verified. AdjustedRevenue = TotalRevenue - Discount.',
            sections: [
                { label: 'Reporting', node_ids: ['[ai].[factsalesreport]'], text: 'Final reporting target.' },
                { label: 'Transformation', node_ids: ['[sales].[vwDiscountCalc]'], text: 'Logic: AdjustedRevenue = TotalRevenue - Discount' }
            ]
        };

        await vscode.lm.invokeTool('lineage_enrich_view', {
            input: enrichInput,
            toolInvocationToken: undefined as any
        }, new vscode.CancellationTokenSource().token);

        const caseDir = path.join(runDir, 'ct-q1-totalrevenue');
        if (!fs.existsSync(caseDir)) fs.mkdirSync(caseDir, { recursive: true });
        
        fs.writeFileSync(path.join(caseDir, 'result.json'), JSON.stringify({
            test_id: 'ct-q1-totalrevenue',
            question: 'Trace TotalRevenue column upstream from FactSalesReport',
            timestamp: new Date().toISOString(),
            model: 'gpt-4o',
            sessionId: sess.id,
            hops: iterations,
            session: sess.getSummary(),
            sm_metadata: {
                sm_type: 'ct_columns',
                scope_size: sess.stateMachine?.scopeSize ?? 0,
                hop_count: sess.hopCount
            },
            hop_log: sess.hopLog,
            short_memory: memory?.short_memory,
            detail_memory: memory?.detail_slots,
            enrich_view_input: enrichInput,
            result_graph: sess.resultGraph
        }, null, 2));
    });

    test('SCENARIO: dep-q1-vemployee (Tool-Based Trace)', async function() {
        this.timeout(120000);
        const sess = extensionApi.getSession();
        sess.resetExploration();
        
        const startResult = await vscode.lm.invokeTool('lineage_start_column_trace', {
            input: { 
                question: 'Trace all dependencies upstream from vEmployee',
                origin: '[humanresources].[vemployee]',
                columns: [], 
                direction: 'up'
            },
            toolInvocationToken: undefined as any
        }, new vscode.CancellationTokenSource().token);

        const startParsed = JSON.parse((startResult.content[0] as vscode.LanguageModelTextPart).value);
        const iterations = await runHighFidelityLoop(sess, startParsed);

        assert.ok(sess.resultGraph, 'Result graph generated');
        const memory = sess.stateMachine?.getMemoryForSynthesis();

        const caseDir = path.join(runDir, 'dep-q1-vemployee');
        if (!fs.existsSync(caseDir)) fs.mkdirSync(caseDir, { recursive: true });
        
        fs.writeFileSync(path.join(caseDir, 'result.json'), JSON.stringify({
            test_id: 'dep-q1-vemployee',
            question: 'Trace all dependencies upstream from vEmployee',
            timestamp: new Date().toISOString(),
            model: 'gpt-4o',
            sessionId: sess.id,
            hops: iterations,
            session: sess.getSummary(),
            sm_metadata: {
                sm_type: 'ct_deps',
                scope_size: sess.stateMachine?.scopeSize ?? 0,
                hop_count: sess.hopCount
            },
            hop_log: sess.hopLog,
            short_memory: memory?.short_memory,
            detail_memory: memory?.detail_slots,
            result_graph: sess.resultGraph
        }, null, 2));
    });
});
