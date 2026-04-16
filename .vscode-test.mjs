import { defineConfig } from '@vscode/test-cli';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.resolve(__dirname, 'tmp-test-workspace');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		ui: 'tdd',
		timeout: 20000
	},
	launchArgs: [tmpDir],
	env: {
		VSCODE_EX_TEST: 'true'
	}
});
