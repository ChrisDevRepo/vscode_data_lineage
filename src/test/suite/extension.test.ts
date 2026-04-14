import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz'));
	});

	test('Extension should activate', async () => {
		const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz');
		if (ext) {
			await ext.activate();
			assert.strictEqual(ext.isActive, true);
		}
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		const expectedCommands = [
			'dataLineageViz.open',
			'dataLineageViz.openDemo',
			'dataLineageViz.openSettings'
		];
		for (const cmd of expectedCommands) {
			assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
		}
	});

	test('Command: Open Wizard should execute', async () => {
		await vscode.commands.executeCommand('dataLineageViz.open');
		// If we reached here without error, the command handler was found and invoked
	});

	test('Command: Open Demo should execute', async () => {
		await vscode.commands.executeCommand('dataLineageViz.openDemo');
		// If we reached here without error, the command handler was found and invoked
	});
});
