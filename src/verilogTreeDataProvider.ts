import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class VerilogTreeDataProvider implements vscode.TreeDataProvider<ModuleNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ModuleNode | undefined> = new vscode.EventEmitter<ModuleNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ModuleNode | undefined> = this._onDidChangeTreeData.event;

  private workspaceRoot: string | undefined;
  private moduleMap: Map<string, ModuleInfo> = new Map(); // 存储模块信息
  private rootModules: ModuleNode[] = []; // 存储根节点
  private logFilePath: string; // 日志文件路径

  // Verilog 关键字列表
  private verilogKeywords = new Set([
    'module', 'begin', 'if', 'else', 'end', 'always', 'assign', 'case', 'default', 'for', 'function', 'initial', 'repeat', 'while', 'fork', 'join', 'generate', 'endgenerate', 'task', 'endtask', 'integer', 'reg', 'wire', 'input', 'output', 'inout', 'parameter', 'localparam'
  ]);

  constructor(workspaceRoot: string | undefined) {
    this.workspaceRoot = workspaceRoot;
    this.logFilePath = path.join(workspaceRoot || __dirname, 'log.txt'); // 设置日志文件路径
    this.refresh();
  }

  // 刷新文件树
  refresh(): void {
    if (!this.workspaceRoot) {
      vscode.window.showErrorMessage('No workspace root found.');
      return;
    }

    // 清空模块信息和根节点
    this.moduleMap.clear();
    this.rootModules = [];

    // 清空日志文件
    fs.writeFileSync(this.logFilePath, '');

    // 解析所有 .v 文件
    this.parseVerilogFiles(this.workspaceRoot);

    // 构建模块调用关系
    this.buildModuleHierarchy();

    // 触发树视图更新
    this._onDidChangeTreeData.fire(undefined);
  }

  // 获取树节点
  getTreeItem(element: ModuleNode): vscode.TreeItem {
    return element;
  }

  // 获取子节点
  getChildren(element?: ModuleNode): Thenable<ModuleNode[]> {
    if (element) {
      // 如果 element 存在，返回其子节点
      this.log(`Getting children for node: ${element.label}`); // 记录日志
      return Promise.resolve(element.children);
    }
    // 如果 element 不存在，返回根节点
    this.log('Getting root nodes'); // 记录日志
    return Promise.resolve(this.rootModules);
  }

  // 解析所有 .v 文件
  private parseVerilogFiles(dir: string) {
    const files = fs.readdirSync(dir);

    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        // 如果是目录，递归解析
        this.parseVerilogFiles(filePath);
      } else if (file.endsWith('.v')) {
        // 如果是 .v 文件，解析模块信息
        this.log(`Parsing file: ${filePath}`); // 记录日志
        this.parseVerilogFile(filePath);
      }
    });
  }

  // 预处理文件
  private removeCommentsAndMacros(content: string): string {
    // 移除单行注释
    content = content.replace(/\/\/.*$/gm, '');

    // 移除多行注释
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');

    // 移除宏定义
    content = content.replace(/`\w+\s*\([^)]*\)/g, '');
    content = content.replace(/`\w+/g, '');

    return content;
  }

  // 解析单个 .v 文件
  private parseVerilogFile(filePath: string) {
    const content = fs.readFileSync(filePath, 'utf-8');
  
    // 过滤注释和宏定义
    const filteredContent = this.removeCommentsAndMacros(content);
  
    // 查找模块定义
    const moduleRegex = /module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\([^)]*\))?\s*;/g;
    let match;
    while ((match = moduleRegex.exec(filteredContent)) !== null) {
      const moduleName = match[1];
      this.log(`Found module: ${moduleName} in file: ${filePath}`);
      if (!this.moduleMap.has(moduleName)) {
        this.moduleMap.set(moduleName, {
          filePath,
          instances: new Set(),
          isRoot: true, // 默认标记为根节点
        });
      }
    }
  
    // 查找模块实例化（包括带有参数化端口的实例化）
    const instanceRegex = /(\w+)\s*(?:#\s*\([^)]*\))?\s+(\w+)\s*\([\s\S]*?\);/g;
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(filteredContent)) !== null) {
      const instanceName = instanceMatch[1];
      const instanceInstance = instanceMatch[2];
      const instanceCode = instanceMatch[0]; // 获取实例化的完整代码片段
  
      // 过滤 Verilog 关键字
      if (!this.verilogKeywords.has(instanceName)) {
        this.log(`Found instance: ${instanceName} (${instanceInstance}) in file: ${filePath}`);
        this.log(`Instance code:\n${instanceCode}`); // 记录实例化的代码片段
        if (this.moduleMap.has(instanceName)) {
          this.moduleMap.get(instanceName)!.isRoot = false; // 如果被实例化，则取消根节点标记
          this.moduleMap.get(instanceName)!.instances.add(instanceInstance);
        }
      }
    }
  }
  
  // 构建模块调用关系
  private buildModuleHierarchy() {
    // 首先将所有未被实例化的模块标记为根节点
    this.moduleMap.forEach((moduleInfo, moduleName) => {
      if (moduleInfo.isRoot) {
        const rootNode = new ModuleNode(moduleName, moduleInfo.filePath);
        this.rootModules.push(rootNode);
        this.log(`Added root node: ${moduleName}`); // 记录日志
      }
    });

    // 为每个模块添加子节点
    this.moduleMap.forEach((moduleInfo, moduleName) => {
      moduleInfo.instances.forEach(instanceName => {
        if (this.moduleMap.has(instanceName)) {
          const parentNode = this.findParentNode(moduleName);
          if (parentNode) {
            const childNode = new ModuleNode(instanceName, this.moduleMap.get(instanceName)!.filePath);
            parentNode.children.push(childNode);
            this.log(`Added child node: ${instanceName} to parent: ${parentNode.label}`); // 记录日志
          }
        }
      });
    });
  }

  // 查找父节点
  private findParentNode(moduleName: string): ModuleNode | undefined {
    for (const rootNode of this.rootModules) {
      const parentNode = this.findNode(rootNode, moduleName);
      if (parentNode) {
        return parentNode;
      }
    }
    return undefined;
  }

  // 递归查找节点
  private findNode(node: ModuleNode, moduleName: string): ModuleNode | undefined {
    if (node.label === moduleName) {
      return node;
    }
    for (const child of node.children) {
      const foundNode = this.findNode(child, moduleName);
      if (foundNode) {
        return foundNode;
      }
    }
    return undefined;
  }

  // 记录日志到文件
  private log(message: string) {
    fs.appendFileSync(this.logFilePath, `${message}\n`);
  }
}

// 模块节点类
class ModuleNode extends vscode.TreeItem {
  children: ModuleNode[] = [];

  constructor(label: string, filePath: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed); // 恢复展开/折叠按钮
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

// 模块信息接口
interface ModuleInfo {
  filePath: string; // 文件路径
  instances: Set<string>; // 实例化模块
  isRoot: boolean; // 是否为根节点
}
