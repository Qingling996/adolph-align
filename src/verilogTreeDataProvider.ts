import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import moment from 'moment-timezone';

export class VerilogTreeDataProvider implements vscode.TreeDataProvider<ModuleNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ModuleNode | undefined> = new vscode.EventEmitter<ModuleNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ModuleNode | undefined> = this._onDidChangeTreeData.event;

  private workspaceRoot: string | undefined;
  private rootNodes: ModuleNode[] = [];
  private logFilePath: string | undefined;
  private moduleGraph: Map<string, Set<string>> = new Map(); // 模块关系图
  private moduleFileMap: Map<string, string> = new Map(); // 模块名到文件路径的映射
  private instanceMap: Map<string, { instanceName: string, moduleName: string }> = new Map(); // 实例化名称到模块名的映射

  // Verilog 关键字列表
  private verilogKeywords = [
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'integer', 'real', 'time', 'realtime',
    'parameter', 'localparam', 'always', 'initial', 'assign', 'begin', 'end', 'if', 'else', 'case', 'casex', 'casez',
    'default', 'for', 'while', 'repeat', 'forever', 'function', 'endfunction', 'task', 'endtask', 'fork', 'join',
    'disable', 'posedge', 'negedge', 'or', 'and', 'xor', 'xnor', 'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1',
    'nand', 'nor', 'specify', 'endspecify', 'specparam', 'pulldown', 'pullup', 'tri', 'triand', 'trior', 'tri0', 'tri1',
    'supply0', 'supply1', 'highz0', 'highz1', 'cmos', 'rcmos', 'nmos', 'pmos', 'rnmos', 'rpmos', 'tran', 'rtran',
    'tranif0', 'rtranif0', 'tranif1', 'rtranif1', 'pullup', 'pulldown', 'primitive', 'endprimitive', 'table', 'endtable',
    'scalared', 'vectored', 'small', 'medium', 'large', 'signed', 'unsigned', 'wait', 'release', 'force', 'deassign',
    'defparam', 'event', 'genvar', 'include', 'timescale', 'use', 'cell', 'liblist', 'design', 'config', 'instance',
    'library', 'incdir', 'define', 'undef', 'ifdef', 'ifndef', 'else', 'elsif', 'endif', 'restrict', 'strong0', 'strong1',
    'weak0', 'weak1', 'highz0', 'highz1', 'supply0', 'supply1', 'on', 'off'
  ];

  constructor(workspaceRoot: string | undefined) {
    this.workspaceRoot = workspaceRoot;
    this.logFilePath = workspaceRoot ? path.join(workspaceRoot, 'log.txt') : undefined;
    this.clearLogFile(); // 清空日志文件
    this.refresh();
  }

  refresh(): void {
    if (!this.workspaceRoot) {
      vscode.window.showErrorMessage('No workspace root found.');
      return;
    }

    this.rootNodes = [];
    this.moduleGraph.clear();
    this.moduleFileMap.clear();
    this.instanceMap.clear();
    this.parseVerilogFiles(this.workspaceRoot);
    this.buildTree();
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
        this.parseVerilogFile(filePath);
      }
    });
  }

  private parsedFiles = new Set<string>();

  private parseVerilogFile(filePath: string) {
    if (this.parsedFiles.has(filePath)) {
      return; // 如果文件已经解析过，直接返回
    }
    this.parsedFiles.add(filePath);

    const content = fs.readFileSync(filePath, 'utf-8');

    // 正则表达式匹配模块名（支持无端口列表的 module 定义）
    const moduleRegex = /module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\([^)]*\))?\s*;/g;
    // 正则表达式匹配实例化名称（支持带参数和不带参数）
    const instanceRegex = /(\b\w+\b)\s*(?:#\s*\([\s\S]*?\))?\s*(\b\w+\b)\s*\([^;]*\)\s*;/gs;

    const logContent: string[] = [];

    // 提取模块名
    let moduleMatch;
    const moduleNames: string[] = [];
    while ((moduleMatch = moduleRegex.exec(content)) !== null) {
      const moduleName = moduleMatch[1];
      moduleNames.push(moduleName); // 保存模块名
      logContent.push(this.formatLogEntry(`Module: ${moduleName}`));

      // 初始化模块关系图
      if (!this.moduleGraph.has(moduleName)) {
        this.moduleGraph.set(moduleName, new Set());
      }

      // 保存模块名到文件路径的映射
      this.moduleFileMap.set(moduleName, filePath);
    }

    // 提取实例化名称
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      const instanceType = instanceMatch[1]; // 实例类型
      const instanceName = instanceMatch[2]; // 实例名称

      // 过滤掉 Verilog 关键字和模块名
      if (!this.isVerilogKeyword(instanceName) && !this.isVerilogKeyword(instanceType) && !moduleNames.includes(instanceName)) {
        logContent.push(this.formatLogEntry(`Instance: ${instanceName} (Type: ${instanceType})`));

        // 更新模块关系图
        moduleNames.forEach(moduleName => {
          if (moduleName !== instanceType) {
            this.moduleGraph.get(moduleName)?.add(instanceType);
          }

          // 保存实例化名称到模块名的映射
          const instanceKey = `${moduleName}.${instanceName}`;
          if (!this.instanceMap.has(instanceKey)) {
            this.instanceMap.set(instanceKey, { instanceName, moduleName: instanceType });
          }
        });
      }
    }

    // 将结果写入 log.txt 文件
    if (logContent.length > 0 && this.logFilePath) {
      fs.appendFileSync(this.logFilePath, `File: ${filePath}\n${logContent.join('\n')}\n\n`);
    }
  }

  // 构建文件树
  private buildTree() {
    const allModules = new Set(this.moduleGraph.keys());
    const usedModules = new Set<string>();

    // 遍历模块关系图，标记被实例化的模块
    for (const [module, dependencies] of this.moduleGraph.entries()) {
      dependencies.forEach(dependency => usedModules.add(dependency));
    }

    // 根节点是那些没有被实例化的模块
    const rootModules = Array.from(allModules).filter(module => !usedModules.has(module));

    // 递归构建树结构
    rootModules.forEach(module => {
      const rootNode = new ModuleNode(
        `${module}`,
        this.moduleFileMap.get(module) || '',
        this.moduleGraph.has(module) && this.moduleGraph.get(module)!.size > 0 // 确保有子节点时才设置为 true
      );
      this.buildSubTree(rootNode, module);
      this.rootNodes.push(rootNode);
    });

    // 调试输出
    console.log('Module Graph:', this.moduleGraph);
    console.log('Instance Map:', this.instanceMap);
    console.log('Root Nodes:', this.rootNodes);
  }

  // 构建子节点
  private buildSubTree(parentNode: ModuleNode, module: string) {
    const dependencies = this.moduleGraph.get(module);
    if (dependencies) {
      dependencies.forEach(dependency => {
        const instanceInfos = Array.from(this.instanceMap.entries()).filter(
          ([key, value]) => key.startsWith(`${module}.`) && value.moduleName === dependency
        );

        if (instanceInfos.length > 0) {
          instanceInfos.forEach(([instanceKey, info]) => {
            const filePath = this.moduleFileMap.get(dependency);
            const isMissing = !filePath; // 判断文件是否缺失
            const childNode = new ModuleNode(
              `${info.instanceName} (${info.moduleName})`,
              filePath || '', // 文件路径为空时表示缺失
              this.moduleGraph.has(dependency) && this.moduleGraph.get(dependency)!.size > 0, // 是否有子节点
              isMissing // 是否缺失文件
            );
            if (!isMissing) {
              this.buildSubTree(childNode, dependency);
            }
            parentNode.children.push(childNode);
          });
        } else {
          console.error(`Instance info not found for module: ${module}, dependency: ${dependency}`);
        }
      });
    }
  }

  private formatLogEntry(message: string): string {
    const now = moment().tz('Asia/Shanghai'); // 转换为北京时间
    const timestamp = now.format('YYYY-MM-DD HH:mm:ss'); // 格式化为北京时间
    return `[${timestamp}] ${message}`;
  }

  private clearLogFile(): void {
    if (this.logFilePath && fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, ''); // 清空文件内容
    }
  }

  // 检查是否为 Verilog 关键字
  private isVerilogKeyword(name: string): boolean {
    return this.verilogKeywords.includes(name);
  }
}

class ModuleNode extends vscode.TreeItem {
  children: ModuleNode[] = [];

  constructor(
    public readonly label: string,
    public readonly filePath: string,
    public readonly hasChildren: boolean = false, // 是否有子节点
    public readonly isMissing: boolean = false // 是否缺失文件
  ) {
    super(
      label,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed // 有子节点时显示“>”
        : vscode.TreeItemCollapsibleState.None // 没有子节点时不显示“>”
    );
    console.log(`Creating node: ${label}, hasChildren: ${hasChildren}, collapsibleState: ${this.collapsibleState}`);
    this.tooltip = filePath || 'File not found'; // 文件路径或提示文件缺失
    this.description = filePath ? path.basename(filePath) : 'File not found'; // 文件名或提示文件缺失
    this.iconPath = {
      light: path.join(__dirname, '..', 'src', isMissing ? 'verilog_tre_missing.png' : 'verilog-icon.png'),
      dark: path.join(__dirname, '..', 'src', isMissing ? 'verilog_tre_missing.png' : 'verilog-icon.png')
    };
    if (filePath) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(filePath)]
      };
    }
  }
}

