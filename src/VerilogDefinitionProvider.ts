import * as vscode from 'vscode';

export class VerilogDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Location | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    const word = wordRange ? document.getText(wordRange) : '';
    if (!word) {
      return undefined;
    }

    // 查找当前模块内是否有定义
    const localDefinition = this.findLocalDefinition(document, word);
    if (localDefinition) {
      return localDefinition; // 直接返回第一处定义
    }

    // 如果当前模块内未定义，查找模块名声明
    const moduleDefinition = await this.findModuleDefinition(word, document.uri);
    return moduleDefinition; // 直接返回第一处定义
  }

  private findLocalDefinition(document: vscode.TextDocument, word: string): vscode.Location | undefined {
    const text = document.getText();

    // 正则表达式匹配变量、参数等定义
    const regex = new RegExp(`\\b(?:wire|reg|parameter|localparam|integer|function|task)\\s+${word}\\b`, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const position = document.positionAt(match.index);
      return new vscode.Location(document.uri, position); // 返回第一处定义
    }

    return undefined;
  }

  private async findModuleDefinition(
    word: string,
    currentFileUri: vscode.Uri
  ): Promise<vscode.Location | undefined> {
    // 在当前文件中查找 module 声明
    const currentFileDocument = await vscode.workspace.openTextDocument(currentFileUri);
    const currentFileText = currentFileDocument.getText();
    const moduleRegex = new RegExp(`\\bmodule\\s+${word}\\b`, 'g');
    let match;
    while ((match = moduleRegex.exec(currentFileText)) !== null) {
      const position = currentFileDocument.positionAt(match.index);
      return new vscode.Location(currentFileUri, position); // 返回第一处定义
    }

    // 在整个工作区中查找 module 声明
    const files = await vscode.workspace.findFiles('**/*.v', '**/*.sv');
    for (const file of files) {
      const document = await vscode.workspace.openTextDocument(file);
      const text = document.getText();
      const moduleMatch = moduleRegex.exec(text);
      if (moduleMatch) {
        const position = document.positionAt(moduleMatch.index);
        return new vscode.Location(document.uri, position); // 返回第一处定义
      }
    }

    return undefined;
  }
}
