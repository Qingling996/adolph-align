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
  // 修改：存储一个模块名对应的所有文件路径的集合
  private moduleFileMap: Map<string, Set<string>> = new Map(); 
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
    this.moduleFileMap.clear(); // 清空文件映射，准备重新填充
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
        // 排除node_modules目录，提高性能
        if (path.basename(filePath).toLowerCase() !== 'node_modules') {
            this.parseVerilogFiles(filePath);
        }
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
    // console.log(`\n====== 开始解析Verilog文件: ${filePath} ======`); // 暂时注释，减少控制台输出

    let content = fs.readFileSync(filePath, 'utf-8');

    // 移除注释
    content = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // 提取模块名（支持无端口列表的 module 定义）
    const moduleRegex = /module\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\([^)]*\))?\s*;/g;

    // 提取模块名
    let moduleMatch;
    const moduleNames: string[] = []; // 当前文件定义的所有模块名
    while ((moduleMatch = moduleRegex.exec(content)) !== null) {
      const moduleName = moduleMatch[1];
      const lowerModule = moduleName.toLowerCase();
      
      // 修改：将文件路径添加到集合中
      if (!this.moduleFileMap.has(lowerModule)) {
        this.moduleFileMap.set(lowerModule, new Set());
      }
      this.moduleFileMap.get(lowerModule)!.add(filePath);
      // console.log(`[Verilog] 存储映射: ${lowerModule} => ${filePath}`); // 暂时注释

      // 初始化模块关系图
      if (!this.moduleGraph.has(lowerModule)) {
        this.moduleGraph.set(lowerModule, new Set());
      }
      moduleNames.push(lowerModule); // 保存当前文件的模块名
    }

    // 提取实例化（支持 Verilog 和 VHDL 调用）
    // 匹配 module_name instance_name (...) ;
    const instanceRegex = /(\b\w+\b)\s*(?:#\s*\([^;]*?\))?\s*(\b\w+\b)\s*\([^;]*\)\s*;/gs;

    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      const instanceType = instanceMatch[1];  // 实例类型 (模块名)
      const instanceName = instanceMatch[2];  // 实例名称
      const lowerInstanceType = instanceType.toLowerCase();

      // 检查是否为有效实例（排除关键字和当前文件定义的模块名）
      // 这里的逻辑是：如果 instanceType *不是* 当前文件定义的任何一个模块名，
      // 并且它不是 Verilog 关键字，就认为它是一个实例化
      if (!this.isVerilogKeyword(instanceName) && 
          !this.isVerilogKeyword(instanceType) &&
          !moduleNames.includes(lowerInstanceType) ) { // 确保instanceType不是当前文件定义的模块名
        
        // 遍历当前文件定义的模块，将实例添加到它们的依赖中
        moduleNames.forEach(parentModule => {
          const parentLower = parentModule.toLowerCase();
          
          // 更新模块关系图（统一小写存储）
          if (!this.moduleGraph.has(parentLower)) {
            this.moduleGraph.set(parentLower, new Set());
          }
          this.moduleGraph.get(parentLower)!.add(lowerInstanceType);

          // 存储实例映射（保留显示用的大小写，但key使用小写）
          const instanceKey = `${parentLower}.${instanceName.toLowerCase()}`;
          this.instanceMap.set(instanceKey, {
            instanceName: instanceName,  // 显示用原始名称
            moduleName: instanceType     // 显示用原始类型 (用于后续查找实际文件)
          });
          // console.log(`[Verilog] 发现实例化: 父模块=${parentLower}, 实例类型=${lowerInstanceType}, 实例名=${instanceName}`); // 暂时注释
        });
      }
    }
    // console.log(`[Verilog] 文件解析完成: ${filePath}\n`); // 暂时注释
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
    // console.log(`\n====== 开始解析VHDL文件: ${filePath} ======`); // 暂时注释

    let content = fs.readFileSync(filePath, 'utf-8');

    // 预处理内容
    content = content
      .replace(/--.*$/gm, '') // 移除行注释
      .replace(/\/\*[\s\S]*?\*\//g, ''); // 移除块注释 (虽然VHDL标准没有块注释，但有些工具或风格会用)
      // 不做统一小写，保留原始字符串用于匹配，但map key用小写

    // 提取实体名（支持多行声明）
    const entityRegex = /entity\s+(\w+)\s+is[\s\S]*?end\s+(?:entity\s+)?(\w+)?\s*;/gmi;
    const entities: string[] = []; // 当前文件定义的所有实体名
    let entityMatch;
    while ((entityMatch = entityRegex.exec(content)) !== null) {
      const entityName = entityMatch[1].trim();
      if (entityName && !this.isVHDLKeyword(entityName)) {
        // console.log(`[VHDL] 发现实体: ${entityName}`); // 暂时注释
        entities.push(entityName);
        const lowerEntity = entityName.toLowerCase();
        
        // 修改：将文件路径添加到集合中
        if (!this.moduleFileMap.has(lowerEntity)) {
          this.moduleFileMap.set(lowerEntity, new Set());
        }
        this.moduleFileMap.get(lowerEntity)!.add(filePath);
        // console.log(`[VHDL] 存储映射: ${lowerEntity} => ${filePath}`); // 暂时注释

        // 初始化模块关系图
        if (!this.moduleGraph.has(lowerEntity)) {
          this.moduleGraph.set(lowerEntity, new Set());
        }
      }
    }

    // 提取实例化（支持 VHDL 和 Verilog 调用）
    // 匹配 instance_label : [entity library_name.]entity_name [(generic|port) map (...)] ;
    const instanceRegex = /(\w+)\s*:\s*(?:entity\s+[\w.]+\.)?(\w+)\s*(generic|port)\s+map[\s\S]*?;/gi;
    let instanceMatch;
    while ((instanceMatch = instanceRegex.exec(content)) !== null) {
      const instanceName = instanceMatch[1]; // 实例 label
      const entityName = instanceMatch[2];   // 实例引用的实体名
      const lowerEntityName = entityName.toLowerCase();

      // 检查是否为有效实例（排除关键字和当前文件定义的实体名）
      // 这里的逻辑是：如果 entityName *不是* 当前文件定义的任何一个实体名，
      // 并且它不是 VHDL 关键字，就认为它是一个实例化
       if (!this.isVHDLKeyword(instanceName) && 
           !this.isVHDLKeyword(entityName) &&
           !entities.map(e => e.toLowerCase()).includes(lowerEntityName)) { // 确保entityName不是当前文件定义的实体名

         // 遍历当前文件定义的实体，将实例添加到它们的依赖中
         entities.forEach(parentEntity => {
           const parentLower = parentEntity.toLowerCase();
           
           // 更新模块关系图（统一小写存储）
           if (!this.moduleGraph.has(parentLower)) {
             this.moduleGraph.set(parentLower, new Set());
           }
           this.moduleGraph.get(parentLower)!.add(lowerEntityName);

           // 保存实例化映射（保留显示用的大小写，但key使用小写）
           const instanceKey = `${parentLower}.${instanceName.toLowerCase()}`;
           this.instanceMap.set(instanceKey, {
             instanceName: instanceName,  // 显示用原始名称
             moduleName: entityName     // 显示用原始类型 (用于后续查找实际文件)
           });
           // console.log(`[VHDL] 发现实例化: 父实体=${parentLower}, 实例类型=${lowerEntityName}, 实例名=${instanceName}`); // 暂时注释
         });
       }
    }
    // console.log(`[VHDL] 文件解析完成: ${filePath}\n`); // 暂时注释
  }

/* ======================================================================================================================== */
/* =========================================================buildTree====================================================== */
/* ======================================================================================================================== */

  private buildTree() {
    const allEntities = Array.from(this.moduleGraph.keys()); // keys已经是小写
    const usedEntities = new Set<string>();

    // 建立依赖关系图
    this.moduleGraph.forEach((dependencies, entity) => {
      dependencies.forEach(dep => usedEntities.add(dep.toLowerCase()));
    });

    // 筛选根节点
    const rootEntities = allEntities.filter(e => !usedEntities.has(e));

    // 生成节点并构建子树
    this.rootNodes = rootEntities.map(entity => {
      const lowerEntity = entity.toLowerCase();
      const filePathsSet = this.moduleFileMap.get(lowerEntity);
      const allFilePaths = Array.from(filePathsSet || []);

      // 选择主要显示的文件路径：优先选择文件名（不含扩展名）与模块名一致的
      let primaryFilePath = '';
      if (allFilePaths.length > 0) {
          primaryFilePath = allFilePaths.find(fp => 
              path.basename(fp, path.extname(fp)).toLowerCase() === lowerEntity
          ) || allFilePaths[0]; // 如果没有匹配的，就选择第一个
      }

      // 判断语言类型基于 primaryFilePath 或 任意一个文件路径（如果primaryFilePath为空）
      const langFilePath = primaryFilePath || (allFilePaths.length > 0 ? allFilePaths[0] : '');
      const isVHDL = langFilePath?.endsWith('.vhd') || langFilePath?.endsWith('.vhdl');

      // 判断是否缺失：只要有任何一个文件存在就不算缺失
      const isMissing = allFilePaths.length === 0;

      const node = new ModuleNode(
        `${entity}${isVHDL ? ' [VHDL]' : ' [Verilog]'}`, // 根节点显示模块名和文件类型
        primaryFilePath, // 主要显示的文件路径
        allFilePaths, // 所有文件路径
        (this.moduleGraph.get(lowerEntity)?.size || 0) > 0,
        isMissing,
        isVHDL ? 'vhdl' : 'verilog'
      );

      // 递归构建子树
      if (!isMissing) { // 只有不缺失的模块才构建子树
        this.buildSubTree(node, entity);
      }

      return node;
    });

    console.log(`构建完成:
      总实体数: ${allEntities.length}
      根节点数: ${rootEntities.length}`);
      // 根节点: ${rootEntities.join(', ')}`); // 暂时注释，太长
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
        // 获取实际模块名称（保留原始大小写） - 从 instanceInfo 获取，或者从 moduleFileMap key 获取
        // 使用 instanceInfo.moduleName 更接近源代码中的写法
        const actualModule = instanceInfo.moduleName; 
        const lowerActualModule = actualModule.toLowerCase();

        // 获取所有文件路径
        const filePathsSet = this.moduleFileMap.get(lowerActualModule);
        const allFilePaths = Array.from(filePathsSet || []);

        // 选择主要显示的文件路径：优先选择文件名（不含扩展名）与模块名一致的
        let primaryFilePath = '';
        if (allFilePaths.length > 0) {
             primaryFilePath = allFilePaths.find(fp => 
                 path.basename(fp, path.extname(fp)).toLowerCase() === lowerActualModule
             ) || allFilePaths[0]; // 如果没有匹配的，就选择第一个
        }

        // 判断语言类型基于 primaryFilePath 或 任意一个文件路径
        const langFilePath = primaryFilePath || (allFilePaths.length > 0 ? allFilePaths[0] : '');
        const isVHDL = langFilePath?.endsWith('.vhd') || langFilePath?.endsWith('.vhdl');

        // 判断是否缺失：只要有任何一个文件存在就不算缺失
        const isMissing = allFilePaths.length === 0;

        // 生成显示名称（实例名 (实际模块名)）
        const displayName = `${instanceInfo.instanceName} (${actualModule})`;
        
        const childNode = new ModuleNode(
          displayName, // 子节点显示实例化名称和模块名
          primaryFilePath, // 主要显示的文件路径
          allFilePaths, // 所有文件路径
          this.moduleGraph.has(lowerActualModule) && this.moduleGraph.get(lowerActualModule)!.size > 0, // 是否有子节点取决于实际模块名是否有依赖
          isMissing,
          isVHDL ? 'vhdl' : 'verilog'
        );

        // 递归构建子树（使用实际模块名）
        if (!isMissing) { // 只有不缺失的模块才构建子树
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
  readonly allFilePaths: string[]; // 新增：存储所有关联的文件路径

  // 修改构造函数，接受所有文件路径列表
  constructor(
    public readonly label: string,
    primaryFilePath: string, // 主要显示的文件路径
    allFilePaths: string[], // 所有关联的文件路径
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

    // 初始化属性
    this.language = languageType;
    this.allFilePaths = allFilePaths; // 存储所有文件路径
    // 使用 primaryFilePath 作为 TreeItem 的 filePath 属性
    this.resourceUri = primaryFilePath ? vscode.Uri.file(primaryFilePath) : undefined;
    // this.filePath = primaryFilePath; // TreeItem 没有 filePath 属性，使用 resourceUri

    // 直接初始化描述和工具提示（强制保持字符串类型）
    // 描述使用 primaryFilePath 或 'File not found'
    const baseName = primaryFilePath ? path.basename(primaryFilePath) : 'File not found';
    const langTag = this.language === 'vhdl' ? '[VHDL]' : '[Verilog]';
    const missingTag = this.isMissing ? ' (missing)' : '';
    
    // 显式声明为字符串类型
    this.description = `${baseName} ${langTag}${missingTag}` as string;
    
    // 构建工具提示内容
    const tooltipLines: string[] = [];
    tooltipLines.push(`Item: ${label}`); // 可以显示完整的 label (实例名+模块名)
    tooltipLines.push(`Language: ${this.language.toUpperCase()}`);
    tooltipLines.push(`Status: ${isMissing ? 'Missing' : 'Located'}`);

    // 显示所有文件路径，如果多于一个
    if (this.allFilePaths.length > 1) {
        tooltipLines.push(`\nDefinitions found in:`);
        this.allFilePaths.forEach(fp => tooltipLines.push(`- ${fp}`));
        // 额外标记出Primary File
        if (primaryFilePath && this.allFilePaths.length > 1) {
             const primaryIndex = tooltipLines.findIndex(line => line === `- ${primaryFilePath}`);
             if (primaryIndex !== -1) {
                 tooltipLines[primaryIndex] += ' (Primary)';
             }
        }
    } else if (primaryFilePath) {
        // 如果只有一个文件，或者没有其他文件，显示 Primary Path
        tooltipLines.push(`Path: ${primaryFilePath}`);
    } else {
        // 如果没有文件路径（isMissing为true）
         tooltipLines.push(`Path: Unknown`);
    }


    // Children count line will be updated later by updateChildrenCount
    tooltipLines.push(`Children: 0 instance(s)`); // Placeholder

    this.tooltip = tooltipLines.join('\n');

    // 图标路径根据语言和缺失状态决定
    this.iconPath = {
      light: vscode.Uri.file(path.join(__dirname, '..', 'src', 
        isMissing ? 'file_missing.png' : 
        this.language === 'vhdl' ? 'vhdl-icon.png' : 'verilog-icon.png')),
      dark: vscode.Uri.file(path.join(__dirname, '..', 'src',
        isMissing ? 'file_missing.png' : 
        this.language === 'vhdl' ? 'vhdl-icon.png' : 'verilog-icon.png'))
    };

    // 文件打开命令使用 primaryFilePath
    if (primaryFilePath) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(primaryFilePath)]
      };
    }

    // 上下文类型
    this.contextValue = this.isMissing ? 'missingModule' : 'normalModule';
  }

  // 更新children时重建整个tooltip字符串
  updateChildrenCount(count: number): void {
      const tooltipLines = (this.tooltip as string).split('\n');
      // 找到以 "Children:" 开头的行并更新
      const childrenLineIndex = tooltipLines.findIndex(line => line.startsWith('Children:'));
      if(childrenLineIndex !== -1) {
         tooltipLines[childrenLineIndex] = `Children: ${count} instance(s)`;
         this.tooltip = tooltipLines.join('\n') as string;
      } else {
         // 如果 Children 行不存在 (应该不会发生)，则添加
         this.tooltip = (this.tooltip as string) + `\nChildren: ${count} instance(s)`;
      }
  }
}
