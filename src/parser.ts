import * as vscode from 'vscode';
import { VerilogTreeNode } from './VerilogTreeProvider';

export function parseVerilogFile(document: vscode.TextDocument): VerilogTreeNode[] {
  const treeNodes: VerilogTreeNode[] = [];
  const text = document.getText();

  // 正则表达式匹配模块
  const moduleRegex = /module\s+(\w+)\s*\(/g;
  let moduleMatch;
  while ((moduleMatch = moduleRegex.exec(text)) !== null) {
    const moduleNode: VerilogTreeNode = {
      label: moduleMatch[1],
      type: 'module',
      location: new vscode.Location(document.uri, document.positionAt(moduleMatch.index)),
      children: [],
    };

    // 正则表达式匹配端口
    const portRegex = /(input|output|inout)\s+(\w+)/g;
    let portMatch;
    while ((portMatch = portRegex.exec(text)) !== null) {
      const portNode: VerilogTreeNode = {
        label: portMatch[2],
        type: 'port',
        location: new vscode.Location(document.uri, document.positionAt(portMatch.index)),
      };
      moduleNode.children?.push(portNode);
    }

    treeNodes.push(moduleNode);
  }

  return treeNodes;
}
