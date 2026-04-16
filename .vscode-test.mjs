import { defineConfig } from '@vscode/test-cli';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// VS Code test workspace dir (replaces old tmp-test-workspace)
const workspaceDir = path.resolve(__dirname, 'test-results', 'workspace');
if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

// Isolated user data dir — required to run alongside another VS Code instance
const userDataDir = path.resolve(__dirname, '.vscode-test', 'user-data');
if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		ui: 'tdd',
		timeout: 20000
	},
	launchArgs: [workspaceDir, '--user-data-dir=' + userDataDir],
	env: {
		VSCODE_EX_TEST: 'true'
	}
});
