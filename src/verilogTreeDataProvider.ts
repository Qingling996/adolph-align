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

export class VerilogTreeDataProvider implements vscode.TreeDataProvider<VerilogModule> {
  private _onDidChangeTreeData: vscode.EventEmitter<VerilogModule | undefined> = new vscode.EventEmitter<VerilogModule | undefined>();
  readonly onDidChangeTreeData: vscode.Event<VerilogModule | undefined> = this._onDidChangeTreeData.event;

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: VerilogModule): vscode.TreeItem {
    return {
      label: element.name,
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      command: {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(element.filePath)],
      },
    };
  }

  getChildren(element?: VerilogModule): Thenable<VerilogModule[]> {
    if (element) {
      return Promise.resolve([]); // 暂时不支持子节点
    } else {
      return this.findVerilogFiles(this.workspaceRoot);
    }
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
      let instanceMatch;
      while ((instanceMatch = instanceRegex.exec(cleanedContent)) !== null) {
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

  private removeCommentsAndMacros(content: string): string {
    // 移除单行注释
    content = content.replace(/\/\/.*$/gm, '');
    // 移除多行注释
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    // 移除宏定义
    content = content.replace(/`\w+\s+.*$/gm, '');
    return content;
  }
}
