import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('AI Integration Suite (Real Copilot Tools)', () => {
    let extensionApi: any;
    let runDir: string;
    const baselineDir = path.resolve(__dirname, '..', '..', '..', 'test-internal', 'ai', 'baselines');

    suiteSetup(async function() {
        this.timeout(20000);
        const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz');
        extensionApi = await ext!.activate();
        
        // Ensure Demo is loaded
        await vscode.commands.executeCommand('dataLineageViz.openDemo');
        const sess = extensionApi.getSession();
        let retries = 30;
        while (retries > 0 && !sess.model) {
            await new Promise(resolve => setTimeout(resolve, 300));
            retries--;
        }

        // Setup run directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const projectRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
        runDir = path.join(projectRoot, 'ai', 'runs', `run-${timestamp}`);
        if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
        if (!fs.existsSync(baselineDir)) fs.mkdirSync(baselineDir, { recursive: true });
    });

    test('Real Copilot: Column Trace (ct-q1-totalrevenue)', async function() {
        this.timeout(180000); // 3 minutes for a real multi-hop trace
        const sess = extensionApi.getSession();
        assert.ok(sess.model, 'Model must be loaded');

        // Clear session
        sess.stateMachine = undefined;
        sess.resultGraph = undefined;

        // Send chat request
        // Note: Using proposed API or workbench command if available. 
        // Based on user feedback, it seems they have a way to trigger it.
        await vscode.commands.executeCommand('workbench.action.chat.open', { 
            query: '@lineage trace TotalRevenue column upstream from [humanresources].[employee]' 
        });

        // Poll for completion (SM status 'complete' or session having a resultGraph)
        let retries = 120; // 2 minutes polling
        while (retries > 0 && (!sess.stateMachine || sess.stateMachine.status !== 'complete')) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries--;
            if (retries % 10 === 0) console.log(`Waiting for AI... (${retries}s left)`);
        }

        assert.ok(sess.stateMachine, 'State machine should have started');
        assert.strictEqual(sess.stateMachine.status, 'complete', 'AI trace should have completed successfully');
        assert.ok(sess.resultGraph, 'Result graph should be generated');

        // Quality Analysis of the result
        const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const caseRunDir = path.join(runDir, 'ct-q1-totalrevenue');
        if (!fs.existsSync(caseRunDir)) fs.mkdirSync(caseRunDir, { recursive: true });

        const dumpPath = path.join(caseRunDir, 'result.json');
        fs.writeFileSync(dumpPath, JSON.stringify({
            test_case: 'ct-q1-totalrevenue',
            timestamp: new Date().toISOString(),
            session: sess.getSummary(),
            state_machine: sess.stateMachine.toJSON(),
            result_graph: sess.resultGraph
        }, null, 2));

        // DETAILED ENRICH VIEW CHECKS
        const graph = sess.resultGraph;
        
        // 1. Math Formula Check
        const hasMath = graph.notes.some((n: any) => n.text.includes('=') || n.text.includes('*'));
        assert.ok(hasMath, 'Enrich view should contain mathematical formulas for revenue calculation');

        // 2. Label Semantic Quality
        const badges = graph.suggested_labels || [];
        const hasSource = badges.some((b: any) => b.text.toLowerCase().includes('source'));
        assert.ok(hasSource, 'Should identify source tables with a "Source" label');

        // 3. Narrative Focus
        const hasEmployeeNote = graph.notes.some((n: any) => n.nodeId.toLowerCase().includes('employee'));
        assert.ok(hasEmployeeNote, 'Should have a specific note for the origin Employee node');

        console.log(`Test ct-q1-totalrevenue completed with ${sess.hopCount} hops.`);
    });
});
