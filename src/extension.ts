import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { alignVerilogCode } from './aligner';

type Alignment = 'left' | 'center' | 'right';

interface VerilogInstance {
  instanceName: string;
  moduleName: string;
}

interface VerilogModule {
  name: string;
  filePath: string;
  instances: VerilogInstance[]; // 修改为 VerilogInstance[]
  children?: VerilogModule[]; // 添加 children 属性
}

// 文件树提供程序
export class VerilogTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

  private modules: VerilogModule[] = []; // 所有模块
  private moduleMap: Map<string, VerilogModule> = new Map(); // 模块名到模块的映射

  // 添加 removeInvisibleCharacters 方法
  private removeInvisibleCharacters(content: string): string {
    // 去除 BOM 字符
    return content.replace(/^\uFEFF/, '');
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  // 获取所有顶层模块
  private getTopLevelModules(): vscode.TreeItem[] {
    const topLevelModules = this.modules.filter(module => {
      return !this.modules.some(m => m.instances.some(inst => inst.moduleName === module.name)); // 保持原始大小写
    });
    return topLevelModules.map(module => this.createTreeItem(module));
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
          this.moduleMap.set(module.name, module); // 确保模块名称大小写敏感
        }
      }
    }
  }

  // 去除注释
  private removeComments(content: string): string {
    // 去除多行注释
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    // 去除单行注释
    content = content.replace(/\/\/.*$/gm, '');
    return content;
  }

  // 去除宏定义
  private removeMacros(content: string): string {
    // 去除 `timescale 和 `define 宏定义
    return content.replace(/`(timescale|define)\s+[^\n]*\n/g, '');
  }

  // 解析 Verilog 模块
  private parseVerilogModule(content: string, filePath: string): VerilogModule | undefined {
    // 去除不可见字符、注释和宏定义
    content = this.removeInvisibleCharacters(content);
    content = this.removeComments(content);
    content = this.removeMacros(content);

    // 改进后的正则表达式
    const moduleRegex = /module\s+(\w+)\s*(?:#\([^)]*\))?\s*(?:\(|;|\n)/gm;

    const moduleMatch = moduleRegex.exec(content);
    if (!moduleMatch) {
      console.error(`未找到模块定义: ${filePath}`);
      return undefined;
    }

    const moduleName = moduleMatch[1]; // 保持原始大小写
    console.log(`解析模块: ${moduleName}, 文件: ${filePath}`);

    const instances: VerilogInstance[] = []; // 存储实例化名称和模块名称

    // 改进后的实例化正则表达式
    const instanceRegex = /(\b\w+\b)\s*(?:#\([^)]*\))?\s*\)\s*(\w+)\s*\(/g;

    // 过滤掉除 module 和门级原语之外的关键字
    const keywordsToFilter = [
      'begin', 'else', 'if', 'case', 'end', 'assign', 'integer', 'for', 'while', 'repeat', 'initial', 'always',
      'task', 'function', 'reg', 'wire', 'input', 'output', 'inout', 'parameter', 'localparam', 'generate',
      'default', 'posedge', 'negedge', 'wait', 'disable', 'fork', 'join', 'forever', 'casex', 'casez', 'deassign',
      'force', 'release', 'specify', 'endspecify', 'specparam', 'time', 'real', 'realtime', 'event', 'wait',
      'disable', 'fork', 'join', 'forever', 'casex', 'casez', 'deassign', 'force', 'release', 'specify', 'endspecify',
      'specparam', 'time', 'real', 'realtime', 'event'
    ];

    const gatePrimitives = [
      'and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf', 'pullup', 'pulldown', 'bufif0', 'bufif1', 'notif0', 'notif1'
    ];

    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      const moduleInstanceName = instanceMatch[1]; // 模块名称
      const instanceName = instanceMatch[2]; // 实例化名称
      // 过滤掉关键字
      if (!keywordsToFilter.includes(instanceName) || gatePrimitives.includes(moduleInstanceName)) {
        instances.push({ instanceName, moduleName: moduleInstanceName });
      }
    }

    console.log(`解析到的模块: ${moduleName}, 实例: ${instances.map(i => i.instanceName).join(', ')}`);
    return { name: moduleName, filePath, instances };
  }

  // 创建树节点
  private createTreeItem(module: VerilogModule, instanceName?: string): vscode.TreeItem {
    const displayName = instanceName ? `${instanceName}_${module.name}` : module.name; // 添加实例化名称前缀
    console.log('创建树节点:', displayName); // 添加日志
    const treeItem = new vscode.TreeItem(displayName, vscode.TreeItemCollapsibleState.Collapsed); // 默认折叠子节点

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
      console.log('获取根节点');
      await this.parseVerilogFiles();
      return this.getTopLevelModules(); // 返回顶层模块
    } else {
      console.log('获取子节点:', element.label);
      const moduleName = element.label as string;
      const module = this.moduleMap.get(moduleName); // 保持原始大小写
      if (module && module.instances && module.instances.length > 0) {
        return module.instances.map(instance => {
          const childModule = this.moduleMap.get(instance.moduleName); // 获取子模块
          if (childModule) {
            return this.createTreeItem(childModule, instance.instanceName); // 子节点添加实例化名称
          } else {
            console.error(`未找到子模块: ${instance.moduleName}`);
            return new vscode.TreeItem(`未找到模块: ${instance.moduleName}`);
          }
        });
      } else {
        return [];
      }
    }
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

export function activate(context: vscode.ExtensionContext) {
  console.log('ADOLPH ALIGN 插件已激活'); // 添加日志

  // 注册 Verilog 对齐命令
  const alignCommand = vscode.commands.registerCommand('adolph-align.align', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // 获取配置
    const config = vscode.workspace.getConfiguration('simpleAlign');

    // 获取选中的文本
    const text = editor.document.getText(editor.selection);

    // 对齐代码
    const alignedText = alignVerilogCode(text, config);

    // 替换选中的文本
    editor.edit(editBuilder => {
      editBuilder.replace(editor.selection, alignedText);
    });
  });

  context.subscriptions.push(alignCommand);

  // 注册括号对齐命令
  registerAlignmentCommand(context, 'left');
  registerAlignmentCommand(context, 'center');
  registerAlignmentCommand(context, 'right');

  // 注册 snippets
  registerSnippets(context, 'verilog');
  registerSnippets(context, 'vhdl');

  // 注册文件树提供程序
  const treeDataProvider = new VerilogTreeDataProvider();
  vscode.window.registerTreeDataProvider('adolphAlignTreeView', treeDataProvider);

  // 注册刷新文件树的命令
  const refreshCommand = vscode.commands.registerCommand('adolphAlign.refresh', () => {
    treeDataProvider.refresh();
  });
  context.subscriptions.push(refreshCommand);
}

// 注册 snippets
function registerSnippets(context: vscode.ExtensionContext, language: 'verilog' | 'vhdl') {
  const snippetsDir = path.join(context.extensionPath, 'snippets');
  const snippetsPath = path.join(snippetsDir, `${language}.json`);

  if (fs.existsSync(snippetsPath)) {
    const snippets = JSON.parse(fs.readFileSync(snippetsPath, 'utf-8'));

    for (const snippetName in snippets) {
      const snippet = snippets[snippetName];
      vscode.languages.registerCompletionItemProvider(language, {
        provideCompletionItems() {
          const completionItem = new vscode.CompletionItem(snippet.prefix, vscode.CompletionItemKind.Snippet);
          completionItem.insertText = new vscode.SnippetString(snippet.body.join('\n'));
          completionItem.documentation = snippet.description;
          return [completionItem];
        }
      });
    }
  }
}

// 注册括号对齐命令
function registerAlignmentCommand(context: vscode.ExtensionContext, align: Alignment) {
  const command = vscode.commands.registerCommand(`adolph-align.${align}`, () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const selection = editor.selection;
    const text = selection.isEmpty
      ? document.lineAt(selection.active.line).text
      : document.getText(selection);

    editor.edit(editBuilder => {
      const range = selection.isEmpty
        ? document.lineAt(selection.active.line).range
        : selection;

      editBuilder.replace(range, alignParenthesesContent(text, align));
    });
  });

  context.subscriptions.push(command);
}

// 对齐括号内容
function alignParenthesesContent(text: string, align: Alignment): string {
  return text.split('\n').map(line => {
    // 如果是注释行，直接返回
    if (line.trim().startsWith('/*') || line.trim().startsWith('//')) {
      return line;
    }

    // 匹配括号内的内容并对齐
    return line.replace(/\(([^)]+)\)/g, (match, content) => {
      const trimmed = content.trim();
      if (!trimmed) return match;

      const alignedContent = alignContent(trimmed, content.length, align);
      return `(${alignedContent})`;
    });
  }).join('\n');
}

// 对齐内容
function alignContent(content: string, availableSpace: number, align: 'left' | 'right' | 'center'): string {
  const contentLength = content.length;

  switch (align) {
    case 'left':
      return content + ' '.repeat(availableSpace - contentLength);
    case 'right':
      return ' '.repeat(availableSpace - contentLength) + content;
    case 'center':
    default:
      const left = Math.floor((availableSpace - contentLength) / 2);
      return ' '.repeat(left) + content + ' '.repeat(availableSpace - contentLength - left);
  }
}

export function deactivate() {}
