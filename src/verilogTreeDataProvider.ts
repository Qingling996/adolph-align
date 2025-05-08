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

        // 解析 Verilog 文件并写入 log.txt
        this.parseVerilogFile(filePath);
      }
    });
  }

  private parseVerilogFile(filePath: string) {
    const content = fs.readFileSync(filePath, 'utf-8');
  
    // 正则表达式匹配模块名
    const moduleRegex = /module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*\(/g;
    // 正则表达式匹配实例化名称（支持带参数和不带参数）
    const instanceRegex = /(\w+)\s*(?:#\s*\([\s\S]*?\))?\s*(\w+)\s*\([\s\S]*?\)/gs; //async_fifo可以识别，switch_ccdl没有识别
    // const instanceRegex = /(\w+)\s*(?:#\s*\([^\)]*\))?\s+(\w+)\s*\([^\)]*\)/g;      //async_fifo可以识别，switch_ccdl可以识别，但多了一堆乱七八糟的（内部的端口，信号，参数等都被识别为实例）
    // const instanceRegex = /(\w+)\s*(?:#\s*\([^\)]*\))?\s+(\w+)\s*\([^;]*?\);/g;     //async_fifo没有识别，switch_ccdl没有识别
    // const instanceRegex = /(\w+)\s*(?:#\s*\([^\)]*\))?\s+(\w+)\s*\([^\)]*?\)\s*;/g; //这个东西就更少了，最差的版本  
    // const instanceRegex = /(\w+)\s*(?:#\s*\([^\)]*\))?\s+(\w+)\s*\([^;]*?\)\s*;/g; //async_fifo没有识别，switch_ccdl没有识别
    // const instanceRegex = /(\w+)\s*(?:#\s*\([^\)]*\))?\s*(\w+)\s*\([^;]*?\)\s*;/g;
    // const instanceRegex = /(\b\w+\b)\s*(?:#\s*\([^\)]*\))?\s*(\b\w+\b)\s*\([^;]*?\)\s*;/g;
    
    const logContent: string[] = [];
  
    // 提取模块名
    let moduleMatch;
    const moduleNames: string[] = [];
    while ((moduleMatch = moduleRegex.exec(content)) !== null) {
      const moduleName = moduleMatch[1];
      moduleNames.push(moduleName); // 保存模块名
      logContent.push(this.formatLogEntry(`Module: ${moduleName}`));
    }
  
    // 提取实例化名称
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      const instanceType = instanceMatch[1]; // 实例类型
      const instanceName = instanceMatch[2]; // 实例名称
  
      // 过滤掉 Verilog 关键字和模块名
      if (!this.isVerilogKeyword(instanceName) && !this.isVerilogKeyword(instanceType) && !moduleNames.includes(instanceName)) {
        logContent.push(this.formatLogEntry(`Instance: ${instanceName} (Type: ${instanceType})`));
      }
    }
  
    // 将结果写入 log.txt 文件
    if (logContent.length > 0 && this.logFilePath) {
      fs.appendFileSync(this.logFilePath, `File: ${filePath}\n${logContent.join('\n')}\n\n`);
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

  constructor(label: string, filePath: string) {
    super(label, vscode.TreeItemCollapsibleState.None);

    // 设置节点图标
    this.iconPath = {
      light: path.join(__dirname, '..', 'src', 'verilog-icon.png'),
      dark: path.join(__dirname, '..', 'src', 'verilog-icon.png')
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
