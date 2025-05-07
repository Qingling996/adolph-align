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

  // 定义 verilogKeywords 属性
  private verilogKeywords: Set<string>;

  constructor(workspaceRoot: string | undefined) {
    this.workspaceRoot = workspaceRoot;
    this.logFilePath = path.join(workspaceRoot || __dirname, 'log.txt'); // 设置日志文件路径

    // 初始化 verilogKeywords
    this.verilogKeywords = new Set([
      "module", "input", "output", "inout", "wire", "reg", "parameter", "localparam",
      "always", "assign", "begin", "end", "if", "else", "case", "default", "for", "while",
      "function", "task", "initial", "forever", "repeat", "posedge", "negedge", "or", "and",
      "xor", "not", "buf", "nand", "nor", "xnor", "real", "integer", "time", "event", "wait",
      "disable", "fork", "join", "specify", "endspecify", "specparam", "defparam", "include",
      "define", "ifdef", "ifndef", "else", "elsif", "endif", "timescale", "generate", "endgenerate",
      "cell", "endcell", "config", "endconfig", "library", "endlibrary", "use", "design", "enddesign",
      "primitive", "endprimitive", "table", "endtable", "edge", "scalared", "vectored", "signed",
      "unsigned", "highz0", "highz1", "small", "medium", "large", "pull0", "pull1", "strong0",
      "strong1", "supply0", "supply1", "tri0", "tri1", "triand", "trior", "trireg", "wand", "wor",
      "worst", "weak0", "weak1", "rtran", "rtranif0", "rtranif1", "tran", "tranif0", "tranif1",
      "cmos", "rcmos", "nmos", "pmos", "rnmos", "rpmos", "pullup", "pulldown", "bufif0", "bufif1",
      "notif0", "notif1", "casex", "casez", "deassign", "force", "release", "with", "within",
      "endprimitive", "endtable", "endtask", "endfunction", "endgenerate", "endmodule", "endconfig",
      "endlibrary", "enddesign", "endcell", "endspecify"
    ]);

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

  // 预处理文件内容：移除实例化中的参数化部分
  private preprocessFileContent(content: string): string {
    // 匹配从 `#` 开始，直到连续两个 `)` 的内容
    const instanceParamRegex = /#\s*\([^)]*\)\s*\)/g;

    // 移除匹配到的参数化部分
    content = content.replace(instanceParamRegex, '');

    return content;
  }

  // 移除注释和宏定义
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

  // 获取当前日期和时间的工具函数
  private getCurrentDateTime(): string {
    const now = new Date();
    return now.toLocaleString();
  }

  // 记录日志到文件
  private log(message: string) {
    const timestamp = this.getCurrentDateTime();
    fs.appendFileSync(this.logFilePath, `[${timestamp}] ${message}\n`);
  }

  // 解析单个 .v 文件
  private parseVerilogFile(filePath: string) {
    const content = fs.readFileSync(filePath, 'utf-8');

    // 预处理文件内容：移除实例化中的参数化部分
    const preprocessedContent = this.preprocessFileContent(content);

    // 提取模块端口、实例化和 endmodule
    const filteredContent = this.extractModuleInfo(preprocessedContent);

    // 将提取的内容输出到日志
    this.log(`Filtered content of file: ${filePath}\n${filteredContent}`);

    // 查找模块定义
    const moduleRegex = /module\s+(\w+)\s*(?:\([^)]*\))?\s*;/g;
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

    // 查找模块实例化
    const instanceRegex = /(\w+)\s+(\w+)\s*\([^;]*\);/g;
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(filteredContent)) !== null) {
        const instanceName = instanceMatch[1];
        const instanceInstance = instanceMatch[2];
        const instanceCode = instanceMatch[0]; // 获取实例化的完整代码片段

        // 过滤 Verilog 关键字
        if (!this.verilogKeywords.has(instanceName) && !this.verilogKeywords.has(instanceInstance)) {
            this.log(`Found instance: ${instanceName} (${instanceInstance}) in file: ${filePath}`);
            this.log(`Instance code:\n${instanceCode}`); // 记录实例化的代码片段
            if (this.moduleMap.has(instanceName)) {
                this.moduleMap.get(instanceName)!.isRoot = false; // 如果被实例化，则取消根节点标记
                this.moduleMap.get(instanceName)!.instances.add(instanceInstance);
            }
        }
    }
  }

  // 提取模块端口、实例化和 endmodule
  private extractModuleInfo(content: string): string {
    // 匹配模块端口定义
    const modulePortRegex = /module\s+\w+\s*\([^)]*\)\s*;/g;

    // 匹配模块实例化
    const instanceRegex = /\w+\s+\w+\s*\([^;]*\);/g;

    // 匹配 endmodule
    const endmoduleRegex = /endmodule/g;

    // 提取匹配的内容
    const modulePorts = content.match(modulePortRegex) || [];
    const instances = content.match(instanceRegex) || [];
    const endmodules = content.match(endmoduleRegex) || [];

    // 合并提取的内容
    const filteredContent = [
        ...modulePorts,
        ...instances,
        ...endmodules,
    ].join('\n');

    return filteredContent;
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
