// alignParentheses.ts
import * as vscode from 'vscode';

type Alignment = 'left' | 'center' | 'right';

// 对齐括号内容
export function alignParenthesesContent(text: string, align: Alignment): string {
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
function alignContent(content: string, availableSpace: number, align: Alignment): string {
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

// 注册括号对齐命令
export function registerAlignmentCommand(context: vscode.ExtensionContext, align: Alignment) {
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
