import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('Extension Functional Integration Suite', () => {
	vscode.window.showInformationMessage('Start all functional tests.');

	let extensionApi: any;

	test('Extension should activate and return API', async () => {
		const allExts = vscode.extensions.all.map(e => e.id);
		console.log('LOADED EXTENSIONS:', JSON.stringify(allExts));
		const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz');
		assert.ok(ext, 'Extension should be present');
		extensionApi = await ext.activate();
		assert.ok(extensionApi, 'Extension should return an API');
		
		// Verify activation log exists via API
		assert.ok(extensionApi.testLogCapture.some((l: string) => l.includes('[Config] Extension activated')), 'Should log activation');
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		const expectedCommands = [
			'dataLineageViz.open',
			'dataLineageViz.openDemo',
			'dataLineageViz.openSettings',
			'dataLineageViz.dumpSmState'
		];
		for (const cmd of expectedCommands) {
			assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
		}
	});

	test('Verify Demo Session State & Tracing', async function() {
		this.timeout(15000);
		const sess = extensionApi.getSession();

		// Trigger demo load via real command
		await vscode.commands.executeCommand('dataLineageViz.openDemo');
		
		// Poll for model loading
		let retries = 30;
		while (retries > 0 && !sess.model) {
			await new Promise(resolve => setTimeout(resolve, 300));
			retries--;
		}

		assert.ok(sess.model, 'Model should be loaded in session via command');
		assert.strictEqual(sess.projectName, 'Demo', 'Project name should be Demo');
		
		// Verify logs from dacpac loading
		assert.ok(extensionApi.testLogCapture.some((l: string) => l.includes('[Dacpac] Demo loaded')), 'Should log dacpac loading');

		// BFS Check
		const nodeId = '[person].[person]';
		const neighbors = sess.model!.neighborIndex[nodeId];
		assert.ok(neighbors && neighbors.out.length > 0, 'Person.Person should have downstream neighbors');
		
		// Search Check
		const { searchCatalog } = await import('../../../src/utils/modelSearch');
		const results = searchCatalog(sess.model!.nodes, 'SalesOrder');
		assert.ok(results.length > 0, 'Should find SalesOrder nodes');
	});

	test('AI Mock: @lineage search for employee', async function() {
		this.timeout(10000);
		const sess = extensionApi.getSession();
		assert.ok(sess.model, 'Model must be loaded for AI test');

		// Let's test the 'search_objects' tool which @lineage calls for search.
		const tool = vscode.lm.tools.find(t => t.name === 'lineage_search_objects');
		assert.ok(tool, 'search_objects tool should be registered');

		const result = await vscode.lm.invokeTool('lineage_search_objects', {
			input: { query: 'employee' },
			toolInvocationToken: undefined as any
		}, new vscode.CancellationTokenSource().token);

		const resultText = (result.content[0] as vscode.LanguageModelTextPart).value;
		const parsed = JSON.parse(resultText);

		assert.ok(Array.isArray(parsed.results), 'Search tool should return results array');
		assert.ok(parsed.results.length > 0, 'Search for "employee" should find tables');

		// Check readability — Note: search tool uses compact presentNode (id, s, n, t)
		const firstMatch = parsed.results[0];
		assert.ok(firstMatch.id && firstMatch.n, 'Result should have id and compact name (n)');
		console.log('AI Search Output Snippet:', resultText.substring(0, 100));
	});

	test('Command: dumpSmState should generate verified JSON', async function() {
		this.timeout(10000);
		const sess = extensionApi.getSession();
		
		// Mock a state machine
		const testTimestamp = new Date().toISOString();
		sess.stateMachine = {
			status: 'complete',
			coveragePct: 0.85,
			slotCount: 3,
			inlineMode: false,
			scopeSize: 12,
			toJSON: () => ({ 
				test_run: true, 
				nodes: ['table_a', 'table_b'],
				timestamp: testTimestamp
			}),
			getHopContext: async () => ({}),
			getResult: async () => ({})
		} as any;

		await vscode.commands.executeCommand('dataLineageViz.dumpSmState');
		
		const wsFolder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(wsFolder, 'Workspace folder should be open');
		
		const dumpsDir = path.join(wsFolder.uri.fsPath, 'ai', 'sm-dumps');
		
		let foundFile: string | null = null;
		for (let i = 0; i < 15; i++) {
			if (fs.existsSync(dumpsDir)) {
				const files = fs.readdirSync(dumpsDir);
				foundFile = files.find(f => f.startsWith('sm-') && f.endsWith('.json')) || null;
				if (foundFile) break;
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		
		assert.ok(foundFile, 'SM dump file should have been created');
		
		const content = fs.readFileSync(path.join(dumpsDir, foundFile!), 'utf-8');
		const parsed = JSON.parse(content);
		assert.strictEqual(parsed.test_run, true);
		assert.ok(parsed.timestamp, 'Should have a timestamp');
		assert.deepStrictEqual(parsed.nodes, ['table_a', 'table_b']);
	});
});
