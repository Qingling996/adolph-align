// src/extension.ts
import * as vscode from 'vscode';
import { alignVerilogCode } from './aligner'; // 导入端口/常量/变量声明对齐功能
import { registerAlignmentCommand } from './alignParentheses'; // 导入括号对齐功能
import { VerilogTreeDataProvider } from './VerilogTreeDataProvider'; // 导入文件树功能
import { registerSnippets } from './snippets'; // 导入代码片段功能
import { generateInstanceCode } from './generateInstanceCode'; // 导入 Verilog 生成模块实例化功能

export function activate(context: vscode.ExtensionContext) {
  console.log('ADOLPH ALIGN 插件已激活');

  // 注册 Verilog 对齐命令
  const alignCommand = vscode.commands.registerCommand('adolph-align.align', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    // 获取配置
    const config = vscode.workspace.getConfiguration('adolphAlign');
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

  // 将命令添加到订阅中
  context.subscriptions.push(refreshCommand);

  // // 注册生成 Verilog 模块实例化代码命令
  // const generateInstanceCommand = vscode.commands.registerCommand('adolph-align.generateInstance', () => {
  //   const editor = vscode.window.activeTextEditor;
  //   if (!editor) {
  //     return; // 没有打开的编辑器
  //   }

  //   const document = editor.document;
  //   const moduleCode = document.getText(); // 获取当前文件内容

  //   // 生成实例化代码
  //   try {
  //     const instanceCode = generateInstanceCode(moduleCode);
  //     editor.edit((editBuilder) => {
  //       // 在文件末尾插入实例化代码
  //       const position = new vscode.Position(document.lineCount, 0);
  //       editBuilder.insert(position, `\n${instanceCode}\n`);
  //     });
  //   } catch (error) {
  //     vscode.window.showErrorMessage(`生成实例化代码失败: ${error.message}`);
  //   }
  // });

  // context.subscriptions.push(generateInstanceCommand);
}

export function deactivate() {}
