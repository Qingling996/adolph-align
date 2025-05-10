import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
*** 注册代码片段
*** @param context - VS Code 扩展上下文
*** @param language - 语言类型（'verilog' 或 'vhdl'）
**/
export function registerSnippets(context: vscode.ExtensionContext, language: 'verilog' | 'vhdl') {
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
