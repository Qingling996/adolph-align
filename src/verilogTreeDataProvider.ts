import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class VerilogTreeDataProvider implements vscode.TreeDataProvider<ModuleNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ModuleNode | undefined> = new vscode.EventEmitter<ModuleNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ModuleNode | undefined> = this._onDidChangeTreeData.event;

  private workspaceRoot: string | undefined;
  private rootNodes: ModuleNode[] = [];
  private logFilePath: string | undefined;
  private moduleGraph: Map<string, Set<string>> = new Map(); // 模块关系图
  private moduleFileMap: Map<string, string> = new Map(); // 模块名到文件路径的映射
  private instanceMap: Map<string, { instanceName: string, moduleName: string }> = new Map(); // 实例化名称到模块名的映射
  private parsedFiles = new Set<string>(); // 已解析的文件

  // Verilog 关键字列表
  private verilogKeywords = [
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'integer', 'real', 'time', 'realtime',
    'parameter', 'localparam', 'always', 'initial', 'assign', 'begin', 'end', 'if', 'else', 'case', 'casex', 'casez',
    'default', 'for', 'while', 'repeat', 'forever', 'function', 'endfunction', 'task', 'endtask', 'fork', 'join',
    'disable', 'posedge', 'negedge', 'or', 'and', 'xor', 'xnor', 'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1',
    'nand', 'nor', 'specify', 'endspecify', 'specparam', 'pulldown', 'pullup', 'tri', 'triand', 'trior', 'tri0', 'tri1',
    'supply0', 'supply1', 'highz0', 'highz1', 'cmos', 'rcmos', 'nmos', 'pmos', 'rnmos', 'rpmos', 'tran', 'rtran',
    'tranif0', 'rtranif0', 'tranif1', 'rtranif1', 'pullup', 'pulldown', 'primitive', 'endprimitive', 'table', 'endtable',
    'scalared', 'vectored', 'small', 'medium', 'large', 'signed', 'unsigned', 'wait', 'release', 'force', 'deassign',
    'defparam', 'event', 'genvar', 'include', 'timescale', 'use', 'cell', 'liblist', 'design', 'config', 'instance',
    'library', 'incdir', 'define', 'undef', 'ifdef', 'ifndef', 'else', 'elsif', 'endif', 'restrict', 'strong0', 'strong1',
    'weak0', 'weak1', 'highz0', 'highz1', 'supply0', 'supply1', 'on', 'off'
  ];

  // VHDL 关键字列表
  private vhdlKeywords = [
    'entity', 'architecture', 'component', 'port', 'map', 'signal', 'process', 'begin', 'end', 'if', 'else', 'case',
    'when', 'for', 'while', 'loop', 'wait', 'function', 'procedure', 'package', 'library', 'use', 'all', 'type', 'constant',
    'variable', 'generic', 'attribute', 'configuration', 'generate', 'record', 'access', 'file', 'alias', 'array',
    'assert', 'block', 'body', 'buffer', 'bus', 'disconnect', 'downto', 'exit', 'guarded', 'in', 'inout', 'is', 'label',
    'linkage', 'literal', 'new', 'next', 'null', 'of', 'on', 'open', 'others', 'out','postponed', 'range',
    'register', 'reject', 'report', 'return', 'select', 'severity', 'shared', 'subtype', 'then', 'to', 'transport',
    'units', 'until', 'with'
  ];

  constructor(workspaceRoot: string | undefined) {
    this.workspaceRoot = workspaceRoot;
    this.logFilePath = workspaceRoot ? path.join(workspaceRoot, 'log.txt') : undefined;
    this.refresh();
  }

  refresh(): void {

    if (!this.workspaceRoot) {
      vscode.window.showErrorMessage('No workspace root found.');
      return;
    }

    this.rootNodes = [];
    this.moduleGraph.clear();
    this.moduleFileMap.clear();
    this.instanceMap.clear();
    this.parsedFiles.clear(); // 清空已解析的文件集合
    this.parseVerilogFiles(this.workspaceRoot);
    this.buildTree();
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
      } else {
        const ext = path.extname(file).toLowerCase();
        if (ext === '.v') {
          this.parseVerilogFile(filePath);
        } else if (ext === '.vhd' || ext === '.vhdl') {
          this.parseVHDLFile(filePath);
        }
      } 
    });
  }

/* ======================================================================================================================== */
/* ====================================================Verilog 关键字检查================================================== */
/* ======================================================================================================================== */

  private isVerilogKeyword(name: string): boolean {
    return this.verilogKeywords.includes(name);
  }

/* ======================================================================================================================== */
/* =====================================================Verilog 文件解析=================================================== */
/* ======================================================================================================================== */

  private parseVerilogFile(filePath: string) {
    if (this.parsedFiles.has(filePath)) {
      return; // 如果文件已经解析过，直接返回
    }
    this.parsedFiles.add(filePath);
    console.log(`\n====== 开始解析Verilog文件: ${filePath} ======`);

    let content = fs.readFileSync(filePath, 'utf-8');

    // 移除注释
    content = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // 提取模块名（支持无端口列表的 module 定义）
    const moduleRegex = /module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\([^)]*\))?\s*;/g;

    // 提取模块名
    let moduleMatch;
    const moduleNames: string[] = [];
    while ((moduleMatch = moduleRegex.exec(content)) !== null) {
      const moduleName = moduleMatch[1];
      // 统一存储为小写（解决大小写敏感问题）
      const lowerModule = moduleName.toLowerCase();
      this.moduleFileMap.set(lowerModule, filePath); // 关键修改
      console.log(`存储映射: ${lowerModule} => ${filePath}`);
      // 初始化模块关系图
      if (!this.moduleGraph.has(lowerModule)) {
        this.moduleGraph.set(lowerModule, new Set());
      }
      moduleNames.push(lowerModule); // 保存当前文件的模块名
    }

    // 提取实例化（支持 Verilog 和 VHDL 调用）
    const instanceRegex = /(\b\w+\b)\s*(?:#\s*\([^;]*?\))?\s*(\b\w+\b)\s*\([^;]*\)\s*;/gs;

    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      const instanceType = instanceMatch[1];  // 实例类型
      const instanceName = instanceMatch[2];  // 实例名称
      const lowerInstanceType = instanceType.toLowerCase();

      // 检查是否为有效实例（排除关键字和当前模块）
      if (!this.isVerilogKeyword(instanceName) && 
          !this.isVerilogKeyword(instanceType) &&
          !moduleNames.includes(lowerInstanceType)) {
        
        moduleNames.forEach(moduleName => {
          const parentModule = moduleName.toLowerCase();
          
          // 更新模块关系图（统一小写存储）
          if (!this.moduleGraph.has(parentModule)) {
            this.moduleGraph.set(parentModule, new Set());
          }
          this.moduleGraph.get(parentModule)!.add(lowerInstanceType);

          // 存储实例映射（保留显示用的大小写）
          const instanceKey = `${parentModule}.${instanceName.toLowerCase()}`;
          this.instanceMap.set(instanceKey, {
            instanceName: instanceName,  // 显示用原始名称
            moduleName: instanceType     // 显示用原始类型
          });

          // 自动关联VHDL实体（如果存在）
          const vhdlEntity = Array.from(this.moduleFileMap.keys())
            .find(k => k.toLowerCase() === lowerInstanceType);
          if (vhdlEntity) {
            this.moduleFileMap.set(lowerInstanceType, this.moduleFileMap.get(vhdlEntity)!);
          }
        });
      }
    }
    console.log(`File: ${filePath}\n\n`); // 打印日志
  }

/* ======================================================================================================================== */
/* =====================================================VHDL关键字检查===================================================== */
/* ======================================================================================================================== */

  private isVHDLKeyword(name: string): boolean {
    return this.vhdlKeywords.includes(name.toLowerCase());
  }

/* ======================================================================================================================== */
/* ====================================================== VHDL 文件解析 =================================================== */
/* ======================================================================================================================== */

  private parseVHDLFile(filePath: string) {
    if (this.parsedFiles.has(filePath)) {
      return;
    }
    this.parsedFiles.add(filePath);
    console.log(`\n====== 开始解析VHDL文件: ${filePath} ======`);
    let content = fs.readFileSync(filePath, 'utf-8');

    // 预处理内容
    content = content
      .replace(/--.*$/gm, '') // 移除注释
      .replace(/\s+/g, ' ')   // 标准化空格
      .toLowerCase();         // 统一小写处理

    // 增强实体识别（支持多行声明）
    const entityRegex = /entity\s+(\w+)\s+is[\s\S]*?end\s+(?:entity\s+)?(\w+)?\s*;/gmi;
    const entities: string[] = [];
    let entityMatch;
    while ((entityMatch = entityRegex.exec(content)) !== null) {
      const entityName = entityMatch[1].trim();
      if (entityName && !this.isVHDLKeyword(entityName)) {
        console.log(`[VHDL] 发现实体: ${entityName}`);
        entities.push(entityName);
        const lowerEntity = entityName.toLowerCase();
        if (!this.moduleGraph.has(lowerEntity)) {
          this.moduleGraph.set(lowerEntity, new Set());
          this.moduleFileMap.set(lowerEntity, filePath);
        }
      }
    }

    // 提取实例化（支持 VHDL 和 Verilog 调用）
    const instanceRegex = /(\w+)\s*:\s*(entity\s+\w+\.)?(\w+)\s*(generic|port)\s+map/gi;
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      const instanceName = instanceMatch[1].toLowerCase();
      const entityName = instanceMatch[3].toLowerCase();

      entities.forEach(parentEntity => {
        const parentLower = parentEntity.toLowerCase();
        if (parentLower !== entityName) {
          this.moduleGraph.get(parentLower)?.add(entityName); // 更新模块关系图
        }

        // 保存实例化映射
        const instanceKey = `${parentLower}.${instanceName}`;
        this.instanceMap.set(instanceKey, {
          instanceName: instanceMatch[1], // 保留原始大小写
          moduleName: entityName
        });
      });
    }
    console.log(`[VHDL] File Finish: ${filePath}\n`);
  }

/* ======================================================================================================================== */
/* =========================================================buildTree====================================================== */
/* ======================================================================================================================== */

  private buildTree() {
    const allEntities = Array.from(this.moduleGraph.keys())
      .map(e => e.toLowerCase());
    const usedEntities = new Set<string>();

    // 建立依赖关系图
    this.moduleGraph.forEach((dependencies, entity) => {
      dependencies.forEach(dep => usedEntities.add(dep.toLowerCase()));
    });

    // 筛选根节点
    const rootEntities = allEntities.filter(e => !usedEntities.has(e));

    // 生成节点并构建子树
    this.rootNodes = rootEntities.map(entity => {
      const filePath = this.moduleFileMap.get(entity);
      const isVHDL = filePath?.endsWith('.vhd') || filePath?.endsWith('.vhdl');

      const node = new ModuleNode(
        `${entity}${isVHDL ? ' [VHDL]' : ' [Verilog]'}`, // 根节点显示模块名和文件类型
        filePath || '',
        (this.moduleGraph.get(entity)?.size || 0) > 0,
        !filePath,
        isVHDL ? 'vhdl' : 'verilog'
      );

      // 递归构建子树
      if (filePath) {
        this.buildSubTree(node, entity);
      }

      return node;
    });

    console.log(`构建完成:
      总实体数: ${allEntities.length}
      根节点: ${rootEntities.join(', ')}`);
  }

/* ======================================================================================================================== */
/* =======================================================buildSubTree===================================================== */
/* ======================================================================================================================== */

  private buildSubTree(parentNode: ModuleNode, currentModule: string) {
    const lowerCurrent = currentModule.toLowerCase();
    const dependencies = this.moduleGraph.get(lowerCurrent);

    if (!dependencies) return;

    dependencies.forEach(depModule => {
      const lowerDep = depModule.toLowerCase();
      
      // 查找所有实例（支持大小写不敏感匹配）
      const instances = Array.from(this.instanceMap.entries())
        .filter(([key, value]) => {
          const [parentKey] = key.split('.');
          return parentKey === lowerCurrent && 
                value.moduleName.toLowerCase() === lowerDep;
        });

      instances.forEach(([instanceKey, instanceInfo]) => {
        // 获取实际模块名称（保留原始大小写）
        const actualModule = Array.from(this.moduleFileMap.keys())
          .find(k => k.toLowerCase() === lowerDep) || depModule;

        const filePath = this.moduleFileMap.get(actualModule.toLowerCase());
        const hasChildren = this.moduleGraph.has(actualModule.toLowerCase()) && 
                          this.moduleGraph.get(actualModule.toLowerCase())!.size > 0;

        // 生成显示名称（实例名 + 实际模块名）
        const displayName = `${instanceInfo.instanceName} (${actualModule})`;
        
        const childNode = new ModuleNode(
          displayName, // 子节点显示实例化名称和模块名
          filePath || '',
          hasChildren,
          !filePath,
          filePath?.endsWith('.vhd') ? 'vhdl' : 'verilog'
        );

        // 递归构建子树（使用实际模块名）
        if (filePath) {
          this.buildSubTree(childNode, actualModule);
        }

        parentNode.children.push(childNode);
      });
    });
  }
}

/* ======================================================================================================================== */
/* =====================================================ModuleNode 类 ===================================================== */
/* ======================================================================================================================== */

class ModuleNode extends vscode.TreeItem {
  children: ModuleNode[] = [];
  readonly language: 'verilog' | 'vhdl';

  // 移除私有属性，改为在构造函数中直接计算
  constructor(
    public readonly label: string,
    public readonly filePath: string,
    public readonly hasChildren: boolean = false,
    public readonly isMissing: boolean = false,
    languageType: 'verilog' | 'vhdl' = 'verilog'
  ) {
    super(
      label,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // 初始化语言类型
    this.language = languageType;

    // 直接初始化描述和工具提示（强制保持字符串类型）
    const baseName = filePath ? path.basename(filePath) : 'File not found';
    const langTag = this.language === 'vhdl' ? '[VHDL]' : '[Verilog]';
    const missingTag = this.isMissing ? ' (missing)' : '';
    
    // 显式声明为字符串类型
    this.description = `${baseName} ${langTag}${missingTag}` as string;
    
    // 构建工具提示内容
    this.tooltip = [
      `Module: ${label}`,
      `Path: ${filePath || 'Unknown'}`,
      `Language: ${this.language.toUpperCase()}`,
      `Status: ${isMissing ? 'Missing' : 'Located'}`,
      `Children: 0 instance(s)`
    ].join('\n');

    // 图标路径
    this.iconPath = {
      light: vscode.Uri.file(path.join(__dirname, '..', 'src', 
        isMissing ? 'file_missing.png' : 
        this.language === 'vhdl' ? 'vhdl-icon.png' : 'verilog-icon.png')),
      dark: vscode.Uri.file(path.join(__dirname, '..', 'src',
        isMissing ? 'file_missing.png' : 
        this.language === 'vhdl' ? 'vhdl-icon.png' : 'verilog-icon.png'))
    };

    // 文件打开命令
    if (filePath) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(filePath)]
      };
    }
  }

  // 更新children时重建整个tooltip字符串
  updateChildrenCount(count: number): void {
    // 保留原始信息重建tooltip
    const tooltipLines = (this.tooltip as string).split('\n');
    tooltipLines[4] = `Children: ${count} instance(s)`; // 更新第五行
    
    // 显式声明为字符串类型
    this.tooltip = tooltipLines.join('\n') as string;
  }

  // 上下文类型
  contextValue = this.isMissing ? 'missingModule' : 'normalModule';
}
