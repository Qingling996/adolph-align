import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface VerilogModule {
  name: string;
  filePath: string;
  instances: { instanceName: string; moduleName: string }[];
}

interface VerilogInstance {
  instanceName: string; // 实例名称
  moduleName: string;   // 模块名称
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
    const files: string[] = [];
    const readDir = async (dir: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await readDir(fullPath); // 递归查找子文件夹
        } else if (entry.isFile() && (entry.name.endsWith('.v') || entry.name.endsWith('.sv'))) {
          files.push(fullPath);
        }
      }
    };
    await readDir(folderPath);
    return files;
  }
  
  private removeComments(content: string): string {
    // 移除单行注释
    content = content.replace(/\/\/.*$/gm, '');
    // 移除多行注释
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    return content;
  }
  
  private removeMacros(content: string): string {
    // 移除宏定义
    content = content.replace(/`\w+\s+.*$/gm, '');
    return content;
  }

  private removeInvisibleCharacters(content: string): string {
    // 移除多余的空格和换行符
    content = content.replace(/\s+/g, ' ').trim();
    return content;
  }
  
  private async parseVerilogModule(filePath: string): Promise<VerilogModule | undefined> {
  try {
    // 读取文件内容
    const content = await fs.promises.readFile(filePath, 'utf-8');
    console.log(`文件内容: ${content}`); // 打印文件内容

    // 移除不可见字符、注释和宏定义
    const cleanedContent = this.removeInvisibleCharacters(content);
    const withoutComments = this.removeComments(cleanedContent);
    const finalContent = this.removeMacros(withoutComments);

    // 解析模块定义
    const moduleRegex = /module\s+(\w+)\s*(?:\([^)]*\))?\s*(?:;|\n|\{)/gm;
    const moduleMatch = moduleRegex.exec(finalContent);
    if (!moduleMatch) {
      console.error(`未找到模块定义: ${filePath}`);
      return undefined;
    }

    const moduleName = moduleMatch[1];
    console.log(`解析模块: ${moduleName}, 文件: ${filePath}`);

    // 解析实例化
    const instances: VerilogInstance[] = [];
    const instanceRegex = /(\b\w+\b)\s+(\w+)\s*\(/g;
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(finalContent)) !== null) {
      const moduleInstanceName = instanceMatch[1];
      const instanceName = instanceMatch[2];
      instances.push({ instanceName, moduleName: moduleInstanceName });
    }

    return { name: moduleName, filePath, instances };
  } catch (error) {
    console.error(`读取文件失败: ${filePath}`, error);
    return undefined;
  }
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
