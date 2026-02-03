# Local Installation Guide

## Install the Extension Locally

### Method 1: Using VS Code UI (Recommended)

1. **Package the extension** (if not already done):
   ```bash
   npm install -g @vscode/vsce
   vsce package
   ```
   This creates `data-lineage-viz-{version}.vsix`

2. **Install in VS Code**:
   - Open VS Code
   - Press `Ctrl+Shift+X` to open Extensions view
   - Click the `...` (three dots) menu at the top
   - Select **"Install from VSIX..."**
   - Navigate to and select `data-lineage-viz-{version}.vsix`
   - Wait for installation to complete
   - Reload VS Code if prompted

### Method 2: Using Command Line

```bash
code --install-extension data-lineage-viz-{version}.vsix
```

### Method 3: Using VS Code Command Palette

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type: `Extensions: Install from VSIX...`
3. Select the `data-lineage-viz-{version}.vsix` file
4. Reload VS Code if prompted

## Verify Installation

1. Press `Ctrl+Shift+P`
2. Type: `Data Lineage`
3. You should see:
   - **Data Lineage: Open**
   - **Data Lineage: Create Parse Rules**

## Using the Extension

### Open a DACPAC File
1. Run command: `Data Lineage: Open`
2. Select your `.dacpac` file
3. Choose schemas to visualize
4. Click "Visualize"

### Try the Demo
1. Run command: `Data Lineage: Open` (select "Open Demo" from the start screen)
2. Explore the sample data warehouse lineage

## Configure Settings

1. Open Settings: `Ctrl+,`
2. Search: `dataLineageViz`
3. Configure:
   - **Max Nodes**: Limit number of nodes (default: 250)
   - **Exclude Patterns**: Regex patterns to exclude objects
   - **Layout Direction**: TB (top-bottom) or LR (left-right)
   - **Trace Levels**: Default upstream/downstream levels
   - **Log Level**: info or debug

### Example Settings (settings.json):
```json
{
  "dataLineageViz.maxNodes": 200,
  "dataLineageViz.layout.direction": "LR",
  "dataLineageViz.excludePatterns": [
    "dbo\\.tmp_.*",
    "staging\\..*",
    ".*_backup$"
  ],
  "dataLineageViz.trace.defaultUpstreamLevels": 5,
  "dataLineageViz.trace.defaultDownstreamLevels": 5,
  "dataLineageViz.logLevel": "debug"
}
```

## Update the Extension

To install a new version:
1. Uninstall the old version (optional)
2. Package the new version: `vsce package`
3. Install the new `.vsix` file using any method above

## Uninstall

1. Open Extensions view: `Ctrl+Shift+X`
2. Find "Data Lineage Viz"
3. Click the gear icon
4. Select "Uninstall"

## Troubleshooting

### Extension Not Loading
1. Check Output Channel: View → Output → select "Data Lineage Viz"
2. Enable debug logging: Set `dataLineageViz.logLevel` to `"debug"`
3. Reload VS Code: `Ctrl+Shift+P` → "Developer: Reload Window"

### Console Logs (Webview)
Press `F12` in the viewer to open Developer Tools and see console logs.

### DACPAC Parse Errors
- Check file format (must be valid DACPAC)
- Review parse rules configuration
- Check Output Channel for detailed error messages

## Development Setup

If you want to modify and test the extension:

```bash
# Clone and install dependencies
git clone https://github.com/ChrisDevRepo/vscode_data_lineage.git
cd vscode_data_lineage
npm install

# Build
npm run build

# Run in development
# Press F5 in VS Code to launch Extension Development Host
```

## File Location

The packaged VSIX file is located at:
```
./data-lineage-viz-{version}.vsix
```

You can copy this file and share it with others for local installation.
