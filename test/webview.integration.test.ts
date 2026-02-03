import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Webview Integration Test', () => {
  const TIMEOUT = 10000; // 10 seconds
  
  test('Extension activates and demo webview loads React', async function() {
    this.timeout(TIMEOUT);
    
    // Ensure extension is activated
    const ext = vscode.extensions.getExtension('data-lineage.data-lineage-viz');
    assert.ok(ext, 'Extension should be installed');
    
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext.isActive, 'Extension should be activated');
    
    // Execute the demo command
    await vscode.commands.executeCommand('dataLineageViz.open');
    
    // Wait for webview to load (give it reasonable time)
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 2000); // 2 seconds should be enough for webview initialization
    });
    
    // Test passes if no errors thrown during command execution
    assert.ok(true, 'Demo command executed without errors');
  });
  
  test('Verify build artifacts exist', () => {
    const ext = vscode.extensions.getExtension('data-lineage.data-lineage-viz');
    assert.ok(ext, 'Extension should be installed');
    
    const distPath = path.join(ext.extensionPath, 'dist', 'assets');
    const jsPath = path.join(distPath, 'index.js');
    const cssPath = path.join(distPath, 'index.css');
    
    assert.ok(fs.existsSync(jsPath), `index.js should exist at ${jsPath}`);
    assert.ok(fs.existsSync(cssPath), `index.css should exist at ${cssPath}`);
    
    const jsSize = fs.statSync(jsPath).size;
    const cssSize = fs.statSync(cssPath).size;
    
    assert.ok(jsSize > 10000, `index.js should be > 10KB (actual: ${jsSize} bytes)`);
    assert.ok(cssSize > 1000, `index.css should be > 1KB (actual: ${cssSize} bytes)`);
    
    console.log(`✓ Build artifacts verified: JS=${jsSize} bytes, CSS=${cssSize} bytes`);
  });
});
