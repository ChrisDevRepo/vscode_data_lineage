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
        runDir = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'tmp-test-workspace', 'ai', 'runs', `run-${timestamp}`);
        if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
        if (!fs.existsSync(baselineDir)) fs.mkdirSync(baselineDir, { recursive: true });
    });

    test('Quick AI: Blackboard Exploration (bb-q1-employee)', async function() {
        this.timeout(60000);
        const sess = extensionApi.getSession();
        assert.ok(sess.model, 'Model must be loaded');

        // Phase 1: Start Exploration
        const startResult = await vscode.lm.invokeTool('lineage_start_exploration', {
            input: { 
                question: 'List all objects that directly read or write the Employee table',
                origin: '[humanresources].[employee]',
                depth: 1
            },
            toolInvocationToken: undefined as any
        }, new vscode.CancellationTokenSource().token);

        const startParsed = JSON.parse((startResult.content[0] as vscode.LanguageModelTextPart).value);
        assert.ok(startParsed.bb_mode === 'exploring', 'Should enter exploring mode');

        // Phase 2: Submit Findings for the first hop
        const focusNodeId = startParsed.focus_node.id;
        assert.ok(focusNodeId, 'Should have a focus node');

        const submitResult = await vscode.lm.invokeTool('lineage_submit_findings', {
            input: {
                focus_node_id: focusNodeId,
                verdict: 'relevant',
                findings: `Analyzed ${focusNodeId}. It reads from HumanResources.Employee and performs an update.`,
                summary: 'Core employee data flow',
                badge_label: 'Processing',
                note_caption: 'Data Processing Node',
                complete: true 
            },
            toolInvocationToken: undefined as any
        }, new vscode.CancellationTokenSource().token);

        const submitParsed = JSON.parse((submitResult.content[0] as vscode.LanguageModelTextPart).value);
        assert.ok(!submitParsed.error, `Submission failed: ${submitParsed.error}`);

        // Phase 3: Final Synthesis (Enrich View)
        const enrichResult = await vscode.lm.invokeTool('lineage_enrich_view', {
            input: {
                name: 'Employee Lineage Report',
                notes: [
                    { node_id: '[humanresources].[employee]', text: 'Source table for HR data.' },
                    { node_id: focusNodeId, text: 'Updates employee login information.' }
                ],
                sections: [
                    { label: 'Source', node_ids: ['[humanresources].[employee]'] },
                    { label: 'Processing', node_ids: [focusNodeId] }
                ],
                badges: [
                    { node_id: '[humanresources].[employee]', text: 'Source' },
                    { node_id: focusNodeId, text: 'Update' }
                ]
            },
            toolInvocationToken: undefined as any
        }, new vscode.CancellationTokenSource().token);

        const enrichParsed = JSON.parse((enrichResult.content[0] as vscode.LanguageModelTextPart).value);
        assert.ok(enrichParsed.ok, 'Enrich view should be successful');

        // Phase 4: Save results for reporting
        const dumpPath = path.join(runDir, 'bb-q1-employee.json');
        const dumpContent = {
            test_case: 'bb-q1-employee',
            timestamp: new Date().toISOString(),
            session: sess.getSummary(),
            state_machine: sess.stateMachine?.toJSON(),
            result_graph: sess.resultGraph,
            last_enrich_payload: enrichParsed // Store the payload for diffing
        };
        fs.writeFileSync(dumpPath, JSON.stringify(dumpContent, null, 2));

        // Quality Assertions
        assert.ok(sess.stateMachine!.toJSON().visited.includes(focusNodeId), 'Node should be marked visited');
        assert.ok(sess.resultGraph.nodeIds.includes('[humanresources].[employee]'), 'Employee should be in result graph');
        
        // Detailed check of labels/notes
        const employeeNote = sess.resultGraph.notes.find((n: any) => n.nodeId === '[humanresources].[employee]');
        assert.ok(employeeNote, 'Should have a note for Employee');
        
        // If a baseline exists, we could diff it here programmatically, 
        // but for now we focus on generating the artifact.
    });
});
