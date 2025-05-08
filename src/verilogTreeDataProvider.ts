import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 模块关系图
const moduleMap = new Map<string, string[]>();

// 解析 Verilog 文件，提取模块定义和实例化信息
function parseVerilogFile(filePath: string) {
    const content = fs.readFileSync(filePath, 'utf-8');

    // 提取模块定义
    const moduleRegex = /module\s+(\w+)\s*\(/g;
    const moduleMatch = content.match(moduleRegex);
    if (!moduleMatch) return;

    const moduleName = moduleMatch[1];

    // 提取实例化信息
    const instanceRegex = /(\w+)\s+#?\(?\s*([^)]*)\s*\)?\s*(\w+)\s*\(/g;
    const instanceMatches = [...content.matchAll(instanceRegex)];
    const instances = instanceMatches.map(match => match[3]);

    // 更新模块关系图
    moduleMap.set(moduleName, instances);
}

// 构建树形结构
interface TreeNode {
    name: string;
    children: TreeNode[];
}

function buildTree(): TreeNode[] {
    const rootNodes: TreeNode[] = [];
    const visited = new Set<string>();

    // 找到所有未被实例化的模块
    const allModules = new Set(moduleMap.keys());
    const referencedModules = new Set([...moduleMap.values()].flat());
    const rootModuleNames = [...allModules].filter(module => !referencedModules.has(module));

    // 递归构建树
    for (const moduleName of rootModuleNames) {
        const node = buildTreeNode(moduleName, visited);
        if (node) rootNodes.push(node);
    }

    return rootNodes;
}

function buildTreeNode(moduleName: string, visited: Set<string>): TreeNode | null {
    if (visited.has(moduleName)) return null;
    visited.add(moduleName);

    const node: TreeNode = {
        name: moduleName,
        children: [],
    };

    const instances = moduleMap.get(moduleName) || [];
    for (const instance of instances) {
        const childNode = buildTreeNode(instance, visited);
        if (childNode) node.children.push(childNode);
    }

    return node;
}

// 文件树视图数据提供者
export class VerilogTreeDataProvider implements vscode.TreeDataProvider<ModuleNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<ModuleNode | undefined> = new vscode.EventEmitter<ModuleNode | undefined>();
    readonly onDidChangeTreeData: vscode.Event<ModuleNode | undefined> = this._onDidChangeTreeData.event;

    private workspaceRoot: string | undefined;
    private rootNodes: ModuleNode[] = [];

    constructor(workspaceRoot: string | undefined) {
        this.workspaceRoot = workspaceRoot;
        this.refresh();
    }

    refresh(): void {
        if (!this.workspaceRoot) {
            vscode.window.showErrorMessage('No workspace root found.');
            return;
        }

        // 清空模块关系图和根节点
        moduleMap.clear();
        this.rootNodes = [];

        // 解析所有 Verilog 文件
        this.parseVerilogFiles(this.workspaceRoot);

        // 构建树形结构
        const treeNodes = buildTree();
        this.rootNodes = treeNodes.map(node => new ModuleNode(node.name, node.children));

        // 触发视图更新
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ModuleNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ModuleNode): Thenable<ModuleNode[]> {
        if (element) {
            return Promise.resolve(element.children);
        }
        return Promise.resolve(this.rootNodes);
    }

    private parseVerilogFiles(dir: string) {
        const files = fs.readdirSync(dir);

        files.forEach(file => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                this.parseVerilogFiles(filePath);
            } else if (file.endsWith('.v')) {
                parseVerilogFile(filePath);
            }
        });
    }
}

// 树节点类
class ModuleNode extends vscode.TreeItem {
    children: ModuleNode[] = [];

    constructor(label: string, children: TreeNode[], filePath?: string) {
        super(label, children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);

        // 设置节点图标
        this.iconPath = {
            light: path.resolve(__dirname, '..', 'src', 'verilog-icon.png'),
            dark: path.resolve(__dirname, '..', 'src', 'verilog-icon.png')
        };

        // 设置节点资源 URI
        if (filePath) {
            this.resourceUri = vscode.Uri.file(filePath);
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(filePath)],
            };
        }

        // 递归创建子节点
        this.children = children.map(child => new ModuleNode(child.name, child.children));
    }
}
