import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface VerilogInstance {
  instanceName: string; // 实例名称
  moduleName: string;   // 模块名称
}

interface VerilogModule {
  name: string;        // 模块名称
  filePath: string;    // 文件路径
  instances: VerilogInstance[]; // 实例列表
}

export class VerilogTreeDataProvider implements vscode.TreeDataProvider<VerilogModule | VerilogInstance> {
  private _onDidChangeTreeData: vscode.EventEmitter<VerilogModule | VerilogInstance | undefined> = new vscode.EventEmitter<VerilogModule | VerilogInstance | undefined>();
  readonly onDidChangeTreeData: vscode.Event<VerilogModule | VerilogInstance | undefined> = this._onDidChangeTreeData.event;

  private modules: VerilogModule[] = []; // 所有模块
  private rootModules: VerilogModule[] = []; // 根节点模块

  constructor(private workspaceRoot: string) {
    this.initialize();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: VerilogModule | VerilogInstance): vscode.TreeItem {
    if ('filePath' in element) {
      // 模块节点
      return {
        label: element.name,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        command: {
          command: 'vscode.open',
          title: 'Open File',
          arguments: [vscode.Uri.file(element.filePath)],
        },
      };
    } else {
      // 实例化节点
      return {
        label: element.instanceName,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      };
    }
  }

  getChildren(element?: VerilogModule | VerilogInstance): Thenable<VerilogModule[] | VerilogInstance[]> {
    if (!element) {
      // 根节点：显示所有根模块
      return Promise.resolve(this.rootModules);
    } else if ('filePath' in element) {
      // 模块节点：显示其实例化节点
      return Promise.resolve(element.instances);
    } else {
      // 实例化节点：显示其对应的模块的实例化节点
      const module = this.modules.find(m => m.name === element.moduleName);
      return Promise.resolve(module ? module.instances : []);
    }
  }

  private async initialize() {
    this.modules = await this.findVerilogFiles(this.workspaceRoot);
    this.rootModules = this.findRootModules(this.modules);
    this.refresh();
  }

  private async findVerilogFiles(folderPath: string): Promise<VerilogModule[]> {
    const files: VerilogModule[] = [];
    const readDir = async (dir: string) => {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await readDir(fullPath); // 递归查找子文件夹
          } else if (entry.isFile() && (entry.name.endsWith('.v') || entry.name.endsWith('.sv'))) {
            console.log(`找到 Verilog 文件: ${fullPath}`); // 打印文件路径
            const module = await this.parseVerilogModule(fullPath);
            if (module) {
              files.push(module);
            }
          }
        }
      } catch (error) {
        console.error(`读取文件夹失败: ${dir}`, error);
      }
    };
    await readDir(folderPath);
    return files;
  }

  private async parseVerilogModule(filePath: string): Promise<VerilogModule | undefined> {
    try {
      // 读取文件内容
      const content = await fs.promises.readFile(filePath, 'utf-8');
      console.log(`文件内容: ${content}`); // 打印文件内容

      // 移除注释和宏定义
      const cleanedContent = this.removeCommentsAndMacros(content);

      // 解析模块定义
      const moduleRegex = /module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\([^)]*\))?\s*(?:;|\n|\{)/gm;
      const moduleMatch = moduleRegex.exec(cleanedContent);
      if (!moduleMatch) {
        console.error(`未找到模块定义: ${filePath}`);
        return undefined;
      }

      const moduleName = moduleMatch[1];
      console.log(`解析模块: ${moduleName}, 文件: ${filePath}`);

      // 解析实例化
      const instances: VerilogInstance[] = [];
      const instanceRegex = /(\b\w+\b)\s+(\w+)\s*\(/g;

      // 需要过滤的关键字列表
      const keywordsToFilter = [
        'begin', 'else', 'if', 'case', 'end', 'assign', 'integer', 'for', 'while', 'repeat', 'initial', 'always',
        'task', 'function', 'reg', 'wire', 'input', 'output', 'inout', 'parameter', 'localparam', 'generate',
        'default', 'posedge', 'negedge', 'wait', 'disable', 'fork', 'join', 'forever', 'casex', 'casez', 'deassign',
        'force', 'release', 'specify', 'endspecify', 'specparam', 'time', 'real', 'realtime', 'event', 'wait',
        'disable', 'fork', 'join', 'forever', 'casex', 'casez', 'deassign', 'force', 'release', 'specify', 'endspecify',
        'specparam', 'time', 'real', 'realtime', 'event'
      ];

      let instanceMatch;
      while ((instanceMatch = instanceRegex.exec(cleanedContent)) !== null) {
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

      return { name: moduleName, filePath, instances };
    } catch (error) {
      console.error(`读取文件失败: ${filePath}`, error);
      return undefined;
    }
  }

  private removeCommentsAndMacros(content: string): string {
    // 移除单行注释
    content = content.replace(/\/\/.*$/gm, '');
    // 移除多行注释
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    // 移除宏定义
    content = content.replace(/`\w+\s+.*$/gm, '');
    return content;
  }

  private findRootModules(modules: VerilogModule[]): VerilogModule[] {
    const calledModules = new Set<string>();
    for (const module of modules) {
      for (const instance of module.instances) {
        calledModules.add(instance.moduleName);
      }
    }

    return modules.filter(module => !calledModules.has(module.name));
  }
}
