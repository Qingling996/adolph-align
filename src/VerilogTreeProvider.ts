import * as vscode from 'vscode';
import { parseVerilogFile } from './parser';

export interface VerilogTreeNode {
  label: string;
  type: 'module' | 'port' | 'signal';
  location?: vscode.Location;
  children?: VerilogTreeNode[];
}

export class VerilogTreeProvider implements vscode.TreeDataProvider<VerilogTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<VerilogTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: VerilogTreeNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.label);
    treeItem.command = {
      command: 'verilogTree.goToLocation',
      title: 'Go to Location',
      arguments: [element.location],
    };
    return treeItem;
  }

  getChildren(element?: VerilogTreeNode): VerilogTreeNode[] {
    if (!element) {
      const document = vscode.window.activeTextEditor?.document;
      if (document) {
        return parseVerilogFile(document);
      }
      return [];
    }
    return element.children || [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}
