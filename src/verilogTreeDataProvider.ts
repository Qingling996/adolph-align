// verilogTreeDataProvider.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

interface VerilogInstance {
  instanceName: string;
  moduleName: string;
}

interface VerilogModule {
  name: string;
  filePath: string;
  instances: VerilogInstance[];
}

// 文件树提供程序
export class VerilogTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

  private modules: VerilogModule[] = [];
  private moduleMap: Map<string, VerilogModule> = new Map();
  debounceTimeout: any;

  // 添加 removeInvisibleCharacters 方法
  private removeInvisibleCharacters(content: string): string {
    return content.replace(/^\uFEFF/, '');
  }

  refresh(): void {
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: '刷新 Verilog 文件树...',
      cancellable: false
    }, async () => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }
  
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  // 获取所有顶层模块
  private getTopLevelModules(): vscode.TreeItem[] {
    const topLevelModules = this.modules.filter(module => {
      // 如果模块没有被其他模块实例化，则认为是顶层模块
      return !this.modules.some(m => 
        m.instances.some(inst => inst.moduleName.toLowerCase() === module.name.toLowerCase())
      );
    });
    return topLevelModules.map(module => this.createTreeItem(module));
  }
  
  // 创建树节点
  private createTreeItem(module: VerilogModule, instanceName?: string): vscode.TreeItem {
    const displayName = instanceName ? `${instanceName}` : module.name;
    console.log('创建树节点:', displayName);
    const treeItem = new vscode.TreeItem(displayName, vscode.TreeItemCollapsibleState.Collapsed);

    if (fs.existsSync(module.filePath)) {
      treeItem.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(module.filePath)]
      };
    } else {
      treeItem.tooltip = `File not found: ${module.filePath}`;
      treeItem.iconPath = {
        light: vscode.Uri.file(path.join(__dirname, '..', 'resources', 'light', 'warning.png')),
        dark: vscode.Uri.file(path.join(__dirname, '..', 'resources', 'dark', 'warning.png'))
      };
    }

    return treeItem;
  }

  // 获取子节点
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // 获取根节点
      return this.getTopLevelModules();
    } else {
      // 获取子节点
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
  
  // 解析所有 Verilog 文件
  private async parseVerilogFiles(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
  
    this.modules = [];
    this.moduleMap.clear();
  
    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath;
      const files = await this.findVerilogFiles(folderPath);
  
      for (const file of files) {
        const filePath = file;
        console.log(`Parsing file: ${filePath}`);
  
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const module = this.parseVerilogModule(content, filePath);
        if (module) {
          this.modules.push(module);
          this.moduleMap.set(module.name.toLowerCase(), module);
        }
      }
    }
  
    this.refresh(); // 刷新文件树
  }
  
  // 去除注释
  private removeComments(content: string): string {
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    content = content.replace(/\/\/.*$/gm, '');
    return content;
  }

  // 去除宏定义
  private removeMacros(content: string): string {
    return content.replace(/`(timescale|define)\s+[^\n]*\n/g, '');
  }

  // 解析 Verilog 模块
  private parseVerilogModule(content: string, filePath: string): VerilogModule | undefined {
    content = this.removeInvisibleCharacters(content);
    content = this.removeComments(content);
    content = this.removeMacros(content);
  
    // 将内容按行分割，合并为单行
    const lines = content.split('\n').map(line => line.trim()).join(' ');
    const moduleRegex = /module\s+(\w+)\s*(?:#\([^)]*\))?\s*(?:\([^)]*\))?\s*(?:;|\n|\{)/gm;
    const moduleMatch = moduleRegex.exec(lines);
    if (!moduleMatch) {
      console.error(`未找到模块定义: ${filePath}`);
      console.error(`文件内容: ${content}`);
      return undefined;
    }
  
    const moduleName = moduleMatch[1];
    console.log(`解析模块: ${moduleName}, 文件: ${filePath}`);
  
    const instances: VerilogInstance[] = [];
    const instanceRegex = /(\b\w+\b)\s*(?:#\([^)]*\))?\s*([a-zA-Z_]\w*)\s*\(/g;
  
    const keywordsToFilter = [
      'begin', 'else', 'if', 'case', 'end', 'assign', 'integer', 'for', 'while', 'repeat', 'initial', 'always',
      'task', 'function', 'reg', 'wire', 'input', 'output', 'inout', 'parameter', 'localparam', 'generate',
      'default', 'posedge', 'negedge', 'wait', 'disable', 'fork', 'join', 'forever', 'casex', 'casez', 'deassign',
      'force', 'release', 'specify', 'endspecify', 'specparam', 'time', 'real', 'realtime', 'event', 'wait',
      'disable', 'fork', 'join', 'forever', 'casex', 'casez', 'deassign', 'force', 'release', 'specify', 'endspecify',
      'specparam', 'time', 'real', 'realtime', 'event'
    ];
  
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(lines)) !== null) {
      const moduleInstanceName = instanceMatch[1];
      const instanceName = instanceMatch[2];
      console.log(`找到实例化: ${moduleInstanceName} ${instanceName}`);
  
      // 过滤掉关键字
      if (!keywordsToFilter.includes(moduleInstanceName) && !keywordsToFilter.includes(instanceName)) {
        instances.push({ instanceName, moduleName: moduleInstanceName });
      } else {
        console.log(`忽略关键字: ${moduleInstanceName} ${instanceName}`);
      }
    }
  
    console.log(`解析到的模块: ${moduleName}, 实例: ${instances.map(i => i.instanceName).join(', ')}`);
    return { name: moduleName, filePath, instances };
  }
  
  // 递归查找 Verilog 文件
  private async findVerilogFiles(folderPath: string): Promise<string[]> {
    const files: string[] = [];
    const verilogFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folderPath, '**/*.v'),
      '**/node_modules/**'
    );

    for (const file of verilogFiles) {
      const filePath = file.fsPath;
      const content = await fs.promises.readFile(filePath, 'utf-8'); // 确保编码为 UTF-8
      if (content.includes('module')) { // 检查是否包含 "module" 关键字
        files.push(filePath);
      }
    }

    return files;
  }
}
