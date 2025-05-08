import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class VerilogTreeDataProvider implements vscode.TreeDataProvider<ModuleNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ModuleNode | undefined> = new vscode.EventEmitter<ModuleNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ModuleNode | undefined> = this._onDidChangeTreeData.event;

  private workspaceRoot: string | undefined;
  private rootNodes: ModuleNode[] = [];

  constructor(workspaceRoot: string | undefined) {
    this.workspaceRoot = workspaceRoot;
    this.refresh();
  }

  refresh(): void {
    if (!this.workspaceRoot) {
      vscode.window.showErrorMessage('No workspace root found.');
      return;
    }

    this.rootNodes = [];
    this.parseVerilogFiles(this.workspaceRoot);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ModuleNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ModuleNode): Thenable<ModuleNode[]> {
    if (element) {
      return Promise.resolve(element.children);
    }
    return Promise.resolve(this.rootNodes);
  }

  private parseVerilogFiles(dir: string) {
    const files = fs.readdirSync(dir);

    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        this.parseVerilogFiles(filePath);
      } else if (file.endsWith('.v')) {
        const moduleName = path.basename(file, '.v');
        const moduleNode = new ModuleNode(moduleName, filePath);
        this.rootNodes.push(moduleNode);
      }
    });
  }
}

class ModuleNode extends vscode.TreeItem {
  children: ModuleNode[] = [];

  constructor(label: string, filePath: string) {
    super(label, vscode.TreeItemCollapsibleState.None);

    // 设置节点图标
    this.iconPath = {
      light: path.join(__dirname, 'verilog-icon.png'), // 使用相对路径引用图标
      dark: path.join(__dirname, 'verilog-icon.png')  // 使用相对路径引用图标
    };

    // 设置节点资源 URI
    this.resourceUri = vscode.Uri.file(filePath);

    // 设置节点点击命令
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}
