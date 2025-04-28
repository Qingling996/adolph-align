import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type Alignment = 'left' | 'center' | 'right';

export function activate(context: vscode.ExtensionContext) {
  // 注册三个独立命令
  registerAlignmentCommand(context, 'left');
  registerAlignmentCommand(context, 'center');
  registerAlignmentCommand(context, 'right');
  
  // 获取 snippets 文件夹路径
  const snippetsDir = path.join(context.extensionPath, 'snippets');

  // 读取 verilog.json 文件
  const verilogSnippetsPath = path.join(snippetsDir, 'verilog.json');
  if (fs.existsSync(verilogSnippetsPath)) {
    const verilogSnippets = JSON.parse(fs.readFileSync(verilogSnippetsPath, 'utf-8'));
    // 将 snippets 注册到 Verilog 语言
    for (const snippetName in verilogSnippets) {
      const snippet = verilogSnippets[snippetName];
      vscode.languages.registerCompletionItemProvider('verilog', {
        provideCompletionItems() {
          const completionItem = new vscode.CompletionItem(snippet.prefix, vscode.CompletionItemKind.Snippet);
          completionItem.insertText = new vscode.SnippetString(snippet.body.join('\n'));
          completionItem.documentation = snippet.description;
          return [completionItem];
        }
      });
    }
  }

  // 读取 vhdl.json 文件
  const vhdlSnippetsPath = path.join(snippetsDir, 'vhdl.json');
  if (fs.existsSync(vhdlSnippetsPath)) {
    const vhdlSnippets = JSON.parse(fs.readFileSync(vhdlSnippetsPath, 'utf-8'));
    // 将 snippets 注册到 VHDL 语言
    for (const snippetName in vhdlSnippets) {
      const snippet = vhdlSnippets[snippetName];
      vscode.languages.registerCompletionItemProvider('vhdl', {
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

function alignParenthesesContent(text: string, align: Alignment): string {
  // 按行分割内容
  const lines = text.split('\n');

  // 对齐每行内容
  const alignedLines = lines.map(line => {
    // 如果是注释行，直接返回
    if (line.trim().startsWith('/*') || line.trim().startsWith('//')) {
      return line;
    }

    // 匹配括号内的内容
    return line.replace(/\(([^)]+)\)/g, (match, content) => {
      // 提取括号内的内容并去除多余空格
      const trimmed = content.trim();
      if (!trimmed) return match;

      // 对齐括号内的内容
      const alignedContent = alignContent(trimmed, content.length, align);

      return `(${alignedContent})`;
    });
  });

  return alignedLines.join('\n');
}

function alignContent(content: string, availableSpace: number, align: Alignment): string {
  const contentLength = content.length;

  let alignedContent: string;
  switch (align) {
    case 'left':
      alignedContent = content + ' '.repeat(availableSpace - contentLength);
      break;
    case 'right':
      alignedContent = ' '.repeat(availableSpace - contentLength) + content;
      break;
    case 'center':
    default:
      const left = Math.floor((availableSpace - contentLength) / 2);
      alignedContent = ' '.repeat(left) + content + ' '.repeat(availableSpace - contentLength - left);
  }

  return alignedContent;
}
