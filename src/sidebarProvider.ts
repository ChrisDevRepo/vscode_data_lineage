import * as vscode from 'vscode';

/** Static entry points shown in the Data Lineage activity view. */
export class SidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  /** Returns the given tree item unchanged. */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /** Returns the static entry list rendered in the view. */
  getChildren(): vscode.TreeItem[] {
    return [
      this.item('Open Wizard', 'dataLineageViz.open', 'graph'),
      this.item('Open Demo', 'dataLineageViz.openDemo', 'play'),
      this.item('Settings', 'dataLineageViz.openSettings', 'gear'),
    ];
  }

  private item(label: string, commandId: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { command: commandId, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }
}
