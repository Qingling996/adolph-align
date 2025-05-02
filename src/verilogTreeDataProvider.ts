import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface VerilogModule {
  name: string;
  filePath: string;
  instances: { instanceName: string; moduleName: string }[];
}

export class VerilogTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

  private modules: VerilogModule[] = [];
  private moduleMap: Map<string, VerilogModule> = new Map();

  constructor() {
    this.parseVerilogFiles();
  }

  refresh(): void {
    console.log('刷新文件树');
    this.parseVerilogFiles();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      console.log('获取根节点');
      return this.getTopLevelModules();
    } else {
      console.log('获取子节点:', element.label);
      const moduleName = element.label as string;
      const module = this.moduleMap.get(moduleName.toLowerCase());
      if (module && module.instances && module.instances.length > 0) {
        return module.instances.map(instance => {
          const childModule = this.moduleMap.get(instance.moduleName.toLowerCase());
          if (childModule) {
            return this.createTreeItem(childModule, instance.instanceName);
          } else {
            return new vscode.TreeItem(`未找到模块: ${instance.moduleName}`);
          }
        });
      } else {
        return [];
      }
    }
  }

  private async parseVerilogFiles(): Promise<void> {
    console.log('开始解析 Verilog 文件');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      console.log('未找到工作区文件夹');
      return;
    }

    this.modules = [];
    this.moduleMap.clear();

    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath;
      console.log('解析文件夹:', folderPath);
      const files = await this.findVerilogFiles(folderPath);

      for (const file of files) {
        const filePath = file;
        console.log('解析文件:', filePath);

        const content = await fs.promises.readFile(filePath, 'utf-8');
        const module = this.parseVerilogModule(content, filePath);
        if (module) {
          console.log('找到模块:', module.name);
          this.modules.push(module);
          this.moduleMap.set(module.name.toLowerCase(), module);
        }
      }
    }

    console.log('Verilog 文件解析完成，找到模块数量:', this.modules.length);
  }

  private async findVerilogFiles(folderPath: string): Promise<string[]> {
    const files = await fs.promises.readdir(folderPath);
    return files
      .filter(file => file.endsWith('.v') || file.endsWith('.sv'))
      .map(file => path.join(folderPath, file));
  }

  private parseVerilogModule(content: string, filePath: string): VerilogModule | undefined {
    const moduleRegex = /module\s+(\w+)\s*\(/;
    const instanceRegex = /(\w+)\s+(\w+)\s*\(/;

    const moduleMatch = content.match(moduleRegex);
    if (!moduleMatch) {
      console.log('未找到模块定义:', filePath);
      return undefined;
    }

    const moduleName = moduleMatch[1];
    const instances: { instanceName: string; moduleName: string }[] = [];

    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      instances.push({
        instanceName: instanceMatch[2],
        moduleName: instanceMatch[1]
      });
    }

    return {
      name: moduleName,
      filePath,
      instances
    };
  }

  private getTopLevelModules(): vscode.TreeItem[] {
    console.log('生成根节点 TreeItem');
    return this.modules.map(module => {
      const treeItem = new vscode.TreeItem(module.name, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.tooltip = module.filePath;
      treeItem.command = {
        command: 'vscode.open',
        title: '打开文件',
        arguments: [vscode.Uri.file(module.filePath)]
      };
      return treeItem;
    });
  }

  private createTreeItem(module: VerilogModule, label: string): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    treeItem.tooltip = module.filePath;
    treeItem.command = {
      command: 'vscode.open',
      title: '打开文件',
      arguments: [vscode.Uri.file(module.filePath)]
    };
    return treeItem;
  }
}
