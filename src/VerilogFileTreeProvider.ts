import * as vscode from 'vscode';
import * as path from 'path';

export class VerilogFileNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly resourceUri?: vscode.Uri
  ) {
    super(label, collapsibleState);
    if (resourceUri) {
      this.resourceUri = resourceUri;
      this.command = {
        command: 'vscode.open',
        title: '打开 Verilog 文件',
        arguments: [resourceUri]
      };
      this.contextValue = 'verilogFile';
    }
  }
}

export class VerilogFileTreeProvider implements vscode.TreeDataProvider<VerilogFileNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<VerilogFileNode | undefined> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<VerilogFileNode | undefined> = this._onDidChangeTreeData.event;
  

  private workspaceRoot: string | undefined;

  constructor() {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined); // 传 undefined 表示刷新全部
  }

  getTreeItem(element: VerilogFileNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VerilogFileNode): Promise<VerilogFileNode[]> {
    if (!this.workspaceRoot) {
      vscode.window.showInformationMessage('未打开工作区，无法显示 Verilog 文件树');
      return [];
    }
    if (!element) {
      return this.getVerilogNodes(this.workspaceRoot);
    } else {
      const dirPath = element.resourceUri ? element.resourceUri.fsPath : path.join(this.workspaceRoot, element.label);
      return this.getVerilogNodes(dirPath);
    }
  }

  private async getVerilogNodes(dirPath: string): Promise<VerilogFileNode[]> {
    const nodes: VerilogFileNode[] = [];
    try {
      const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
      for (const [name, fileType] of files) {
        if (fileType === vscode.FileType.Directory) {
          nodes.push(new VerilogFileNode(
            name,
            vscode.TreeItemCollapsibleState.Collapsed,
            vscode.Uri.file(path.join(dirPath, name))
          ));
        } else if (
          fileType === vscode.FileType.File &&
          (name.endsWith('.v') || name.endsWith('.sv'))
        ) {
          nodes.push(new VerilogFileNode(
            name,
            vscode.TreeItemCollapsibleState.None,
            vscode.Uri.file(path.join(dirPath, name))
          ));
        }
      }
      nodes.sort((a, b) => {
        if (a.collapsibleState === b.collapsibleState) {
          return a.label.localeCompare(b.label);
        }
        return a.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed ? -1 : 1;
      });
    } catch (error) {
      console.error('读取目录失败:', error);
    }
    return nodes;
  }
}
