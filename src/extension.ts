import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { alignVerilogCode } from './aligner'; // 导入端口/常量/变量声明对齐功能
import { registerAlignmentCommand } from './alignParentheses'; // 导入括号对齐功能
import { VerilogTreeDataProvider } from './verilogTreeDataProvider'; // 导入文件树功能

export function activate(context: vscode.ExtensionContext) {
  console.log('ADOLPH ALIGN 插件已激活');

  // 注册 Verilog 对齐命令
  const alignCommand = vscode.commands.registerCommand('adolph-align.align', () => {
    console.log('执行 Verilog 对齐命令');
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
  console.log('注册括号对齐命令');
  registerAlignmentCommand(context, 'left');
  registerAlignmentCommand(context, 'center');
  registerAlignmentCommand(context, 'right');

  // 注册 snippets
  console.log('注册 snippets');
  registerSnippets(context, 'verilog');
  registerSnippets(context, 'vhdl');

  // 注册文件树提供程序
  console.log('注册文件树提供程序');
  const treeDataProvider = new VerilogTreeDataProvider();
  vscode.window.registerTreeDataProvider('adolphAlignTreeView', treeDataProvider);

  // 注册刷新文件树的命令
  console.log('注册刷新文件树命令');
  const refreshCommand = vscode.commands.registerCommand('adolphAlign.refresh', () => {
    console.log('执行刷新文件树命令');
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

export function deactivate() {}
