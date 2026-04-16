import * as assert from 'assert';
import * as vscode from 'vscode';

suite('AI Integration Suite (Real Copilot Tools)', () => {
    let extensionApi: any;

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
    });

    test('Quick AI: Blackboard Exploration (bb-q1-employee)', async function() {
        this.timeout(30000);
        const sess = extensionApi.getSession();
        assert.ok(sess.model, 'Model must be loaded');

        // Phase 1: Start Exploration
        // Equivalent to legacy: "List all objects that directly read or write the Employee table"
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
        assert.ok(sess.stateMachine, 'State machine should be active');
        assert.strictEqual(sess.stateMachine!.constructor.name, 'BlackboardState');

        // Phase 2: Submit Findings for the first hop
        const focusNodeId = startParsed.focus_node.id;
        assert.ok(focusNodeId, 'Should have a focus node');
        console.log('AI Focus Node:', focusNodeId);

        const submitResult = await vscode.lm.invokeTool('lineage_submit_findings', {
            input: {
                focus_node_id: focusNodeId,
                verdict: 'relevant',
                findings: `Analyzed ${focusNodeId}. It is part of the employee lineage.`,
                summary: 'Part of employee data flow',
                badge_label: 'Processing',
                note_caption: 'Data Processing Node',
                complete: true // Early complete for a "Quick" test
            },
            toolInvocationToken: undefined as any
        }, new vscode.CancellationTokenSource().token);

        const submitParsed = JSON.parse((submitResult.content[0] as vscode.LanguageModelTextPart).value);
        if (submitParsed.error) {
            console.error('SUBMIT FAILED:', JSON.stringify(submitParsed, null, 2));
        }
        assert.ok(!submitParsed.error, `Submission failed: ${submitParsed.error}`);
        
        // Phase 3: Assert on State
        const resultGraph = sess.resultGraph;
        // In this test, we might not have a final resultGraph yet if early_complete didn't fire.
        // But we can check if the node was visited.
        assert.ok(sess.stateMachine!.toJSON().visited.includes(focusNodeId), 'Node should be marked visited');
        
        // Check telemetry in logs
        console.log('CAPTURED LOGS:', JSON.stringify(extensionApi.testLogCapture, null, 2));
        assert.ok(extensionApi.testLogCapture.some((l: string) => l.includes('[BB] BB START')), 'Telemetry should reflect BB START');
        // If we visited uspUpdateEmployeeHireInfo (which is likely the focus node), it will AUTO-ADD its neighbors.
        assert.ok(extensionApi.testLogCapture.some((l: string) => l.includes('[BB] BB AUTO-ADD')), 'Telemetry should reflect BB AUTO-ADD');
    });
});
