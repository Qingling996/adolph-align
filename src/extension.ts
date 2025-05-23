import * as vscode from 'vscode';
import * as path from 'path';
import { alignVerilogCode } from './aligner'; // 导入端口/常量/变量声明对齐功能
import { registerAlignmentCommand } from './alignParentheses'; // 导入括号对齐功能
import { VerilogTreeDataProvider } from './VerilogTreeDataProvider'; // 导入文件树功能
import * as child_process from 'child_process';
import { registerSnippets } from './snippets'; // 导入代码片段功能
import { VerilogDefinitionProvider } from './VerilogDefinitionProvider'; // 导入文件跳转功能

export function activate(context: vscode.ExtensionContext) {
  console.log('ADOLPH ALIGN 插件已激活');

  // 注册 Verilog 对齐命令
  const alignCommand = vscode.commands.registerCommand('adolph-align.align', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // 获取配置
    const config = vscode.workspace.getConfiguration('adolphAlign');
    // console.log('配置已加载:', config);

    // 获取选中的文本
    const text = editor.document.getText(editor.selection);

    // 对齐代码
    const alignedText = alignVerilogCode(text, config);

    // 替换选中的文本
    editor.edit(editBuilder => {
      editBuilder.replace(editor.selection, alignedText);
    });

    console.log('Verilog align 已执行');
  });

  context.subscriptions.push(alignCommand);

  // 监听配置变化
  vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('adolphAlign')) {
      console.log('配置已修改，重新执行对齐逻辑');
      vscode.commands.executeCommand('adolph-align.align');
    }
  });

  // 注册括号对齐命令
  console.log('括号对齐 已注册');
  registerAlignmentCommand(context, 'left');
  registerAlignmentCommand(context, 'center');
  registerAlignmentCommand(context, 'right');

  // 注册 snippets
  console.log('snippets 已注册');
  registerSnippets(context, 'verilog');
  registerSnippets(context, 'vhdl');

  // 获取当前工作区根目录
  const workspaceRoot = vscode.workspace.rootPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace root found.');
    return;
  }

  // 注册文件树视图
  const verilogTreeDataProvider = new VerilogTreeDataProvider(workspaceRoot);
  vscode.window.registerTreeDataProvider('verilogFileTree', verilogTreeDataProvider);

  console.log('Verilog File Tree 已注册');

  // 注册刷新命令
  const refreshCommand = vscode.commands.registerCommand('verilogFileTree.refresh', () => {
    verilogTreeDataProvider.refresh();
  });

  // 注册 "在文件夹中显示" 命令
  context.subscriptions.push(vscode.commands.registerCommand('verilogTree.openContainingFolder', (node: any) => {
      // 检查传入的 node 是否是 ModuleNode 实例或包含 resourceUri
      if (node && node.resourceUri && node.resourceUri.scheme === 'file') {
          // 使用 VS Code 内置命令 revealFileInOS
          // 这个命令通常会打开文件所在的文件夹并在文件管理器中选中文件
          vscode.commands.executeCommand('revealFileInOS', node.resourceUri);
      } else {
          vscode.window.showErrorMessage('Cannot open folder: Invalid file path or file not found.');
      }
  }));

  // 将命令添加到订阅中
  // context.subscriptions.push(refreshCommand, showInFolderCommand);

  // 注册 DefinitionProvider
  const definitionProvider = new VerilogDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('verilog', definitionProvider)
  );

  // 确保插件激活后调用刷新命令
  vscode.commands.executeCommand('verilogFileTree.refresh');
}

export function deactivate() {}
