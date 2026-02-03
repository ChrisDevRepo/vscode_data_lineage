import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { execSync } from 'child_process';

async function main() {
  try {
    // First compile the TypeScript test files
    console.log('Compiling test files...');
    execSync('npx tsc -p test/tsconfig.json', { 
      cwd: path.resolve(__dirname, '../'),
      stdio: 'inherit'
    });
    console.log('Test files compiled successfully');

    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, '../');

    // The path to the extension test runner script
    const extensionTestsPath = path.resolve(__dirname, './out/suite/index');

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-extensions', // Disable other extensions
        '--disable-gpu',
        '--no-sandbox',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--new-window' // Reuse existing window instead of spawning many
      ],
      reuseMachineInstall: true // Reuse existing VS Code installation
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
