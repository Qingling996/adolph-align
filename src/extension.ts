import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { alignVerilogCode } from './aligner';
import { VerilogTreeProvider } from './VerilogTreeProvider';

type Alignment = 'left' | 'center' | 'right';

export function activate(context: vscode.ExtensionContext) {
  // 注册文件树提供器
  const treeDataProvider = new VerilogTreeProvider();
  vscode.window.registerTreeDataProvider('verilogTree', treeDataProvider);

  // 监听文件变化，刷新文件树
  vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document === vscode.window.activeTextEditor?.document) {
      treeDataProvider.refresh();
    }
  });
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
