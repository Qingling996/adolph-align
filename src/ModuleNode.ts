import * as vscode from 'vscode';

export class ModuleNode extends vscode.TreeItem {
  children: ModuleNode[] = [];

  constructor(
    public readonly label: string,
    public readonly filePath: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
  ) {
    super(label, collapsibleState);
    this.tooltip = filePath;
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)]
    };
  }
}
