import * as vscode from 'vscode';
import { WorkspaceConfiguration } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// =========================================================================
// 接口定义
// =========================================================================
interface CommentInfo {
  text: string;
  type: 'line' | 'block';
  originalTokenIndex: number;
}

interface ASTNode {
  name: string;
  children?: ASTNode[];
  value?: string;
  start?: { line: number; column: number; };
  end?: { line: number; column: number; };
  leadingComments?: CommentInfo[];
  trailingComments?: CommentInfo[];
}

// =========================================================================
// 插件入口函数
// =========================================================================

export function alignVerilogCode(text: string, config: vscode.WorkspaceConfiguration, isAST: boolean = true, astFilePath?: string): string {
  console.log(`[Aligner] alignVerilogCode called. isAST: ${isAST}, input text length: ${text.length}`);
  console.log(`[Aligner] Using AST file: ${astFilePath}`);

  if (!astFilePath || !fs.existsSync(astFilePath)) {
    console.error(`[Aligner] Error: AST file not found or path not provided: ${astFilePath}`);
    return text;
  }

  const ast = loadAST(astFilePath);

  // processedCommentIndices ensures comments are processed only once
  const processedCommentIndices = new Set<number>();

  // =========================================================================
  // 内部辅助函数 (AST 处理相关) - 仅在此 alignVerilogCode 函数内部可见
  // =========================================================================

  function loadAST(filePath: string): ASTNode {
    console.log(`[Aligner-AST] Loading AST from: ${filePath}`);
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }

  // --- 辅助函数：查找某个节点下的终端节点 ---
  function findTerminalNode(node: ASTNode, terminalName: string): ASTNode | undefined {
    if (!node) return undefined;
    if (node.name === terminalName && node.value !== undefined) {
      return node;
    }
    if (node.children) {
      for (const child of node.children) {
        const found = findTerminalNode(child, terminalName);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * 最底层：递归地获取 ASTNode 的原始纯文本内容。
   * 不添加任何缩进、换行或注释。
   * @param node ASTNode 节点
   * @returns 节点的纯代码文本
   */
  function getRawNodeText(node: ASTNode): string {
    if (!node) {
      return '';
    }

    // --- 1. 处理叶子节点 (Token) ---
    if (node.value !== undefined) {
      if (node.name === '\\\\<EOF>') {
        return '';
      }
      switch (node.name) {
        case 'PLUS': case 'MINUS': case 'STAR': case 'DIV': case 'MOD':
        case 'LOG_AND': case 'LOG_OR': case 'LOG_EQ': case 'LOG_NEQ':
        case 'CASE_EQ': case 'CASE_NEQ': case 'BIT_AND': case 'BIT_OR':
        case 'BIT_XOR': case 'LEFT_SHIFT': case 'RIGHT_SHIFT':
        case 'LESS': case 'LE_OP': case 'GREATER': case 'GREATER_EQ':
        case 'OR':
          return ` ${node.value} `;
        case 'COMMA':
          return node.value;
        case 'LOG_NOT': case 'BIT_NOT':
          return node.value;
        case 'COLON':
          return `:${node.value}`;
        case 'SEMI':
          return node.value;
        case 'LPAREN': case 'RPAREN': case 'LBRACK': case 'RBRACK': case 'LBRACE':
          return node.value;
        case 'HASH':
          return node.value;
        case 'ASSIGN_EQ':
          return ` = `;
        case 'LE_OP':
          return ` <= `;
        default:
          return node.value;
      }
    } else {
      // --- 2. 处理非叶子节点 (规则上下文) ---
      let content = '';
      let prevChildContent = '';

      node.children?.forEach(child => {
        const childContent = getRawNodeText(child);

        if (childContent.length > 0) {
          const lastCharOfPrev = prevChildContent.slice(-1);
          const firstCharOfChild = childContent.trimStart().charAt(0);

          const needsSpace = (
            prevChildContent.length > 0 &&
            prevChildContent.trim() !== '' &&
            childContent.trim() !== '' &&
            !['(', '[', '{', '.', ',', ';', ':', '`', '~', '!'].includes(firstCharOfChild) &&
            !['(', '[', '{'].includes(lastCharOfPrev) &&
            !['.', ','].includes(lastCharOfPrev) &&
            (/\w/.test(lastCharOfPrev) && /\w/.test(firstCharOfChild)) // Word characters need space between
          );

          if (needsSpace) {
            content += ' ';
          }
          content += childContent;
          prevChildContent = childContent;
        }
      });
      return content;
    }
  }

  /**
   * 辅助函数：将注释转换为带缩进的字符串，每行一个换行符。
   * 并确保注释只被处理一次。
   * @param comments 注释列表
   * @param indentStr 缩进字符串
   * @returns 格式化后的注释字符串
   */
  function formatComments(comments: CommentInfo[] | undefined, indentStr: string): string {
    let formatted = '';
    if (comments) {
      comments.forEach(comment => {
        if (!processedCommentIndices.has(comment.originalTokenIndex)) {
          formatted += indentStr + comment.text + '\n';
          processedCommentIndices.add(comment.originalTokenIndex);
        }
      });
    }
    return formatted;
  }

  /**
   * 核心通用格式化器：
   * 负责添加节点自身的前导/尾随注释、根据缩进级别添加缩进，并根据节点类型在末尾添加换行。
   * 它会调用 `formatXxxBlock` 来获取节点的核心代码内容。
   * @param node ASTNode 节点
   * @param config 配置对象
   * @param currentIndentLevel 当前缩进级别
   * @returns 格式化后的代码字符串，包含缩进和换行
   */
  function formatASTNode(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    if (!node) {
      return '';
    }

    const baseIndent = '    ';
    let formattedCodeBlock = ''; // 存储从 formatXxxBlock 获取的、包含其内部格式的核心代码块

    // --- 1. 获取节点的核心代码块内容 ---
    // 每个 formatXxxBlock 函数负责其内部的缩进和换行
    switch (node.name) {
      // 模块结构
      case 'module_declaration': formattedCodeBlock = formatModuleBlock(node, config, currentIndentLevel); break;
      case 'module_body': formattedCodeBlock = formatModuleBodyBlock(node, config, currentIndentLevel); break;
      case 'module_item': formattedCodeBlock = formatModuleItemBlock(node, config, currentIndentLevel); break;
      case 'ansi_port_list': formattedCodeBlock = formatAnsiPortListBlock(node, config, currentIndentLevel); break;
      case 'ansi_port_declaration': formattedCodeBlock = formatAnsiPortDeclarationBlock(node, config, currentIndentLevel); break;
      case 'parameter_port_list': formattedCodeBlock = formatParameterPortListBlock(node, config, currentIndentLevel); break;
      case 'param_assignment': formattedCodeBlock = formatParamAssignmentBlock(node, config, currentIndentLevel); break;

      // 模块实例化
      case 'module_instantiation_item': formattedCodeBlock = formatModuleInstantiationItemBlock(node, config, currentIndentLevel); break;
      case 'module_instantiation': formattedCodeBlock = formatModuleInstantiationBlock(node, config, currentIndentLevel); break;
      case 'parameter_value_assignment': formattedCodeBlock = formatParameterValueAssignmentBlock(node, config, currentIndentLevel); break;
      case 'list_of_parameter_assignments': formattedCodeBlock = formatListOfParameterAssignmentsBlock(node, config, currentIndentLevel); break;
      case 'named_parameter_assignment': formattedCodeBlock = formatNamedParameterAssignmentBlock(node, config, currentIndentLevel); break;
      case 'ordered_parameter_assignment': formattedCodeBlock = formatOrderedParameterAssignmentBlock(node, config, currentIndentLevel); break;
      case 'module_instance': formattedCodeBlock = formatModuleInstanceBlock(node, config, currentIndentLevel); break;
      case 'list_of_port_connections': formattedCodeBlock = formatListOfPortConnectionsBlock(node, config, currentIndentLevel); break;
      case 'named_port_connection': formattedCodeBlock = formatNamedPortConnectionBlock(node, config, currentIndentLevel); break;
      case 'ordered_port_connection': formattedCodeBlock = formatOrderedPortConnectionBlock(node, config, currentIndentLevel); break;
      
      // 声明
      case 'net_declaration': formattedCodeBlock = formatNetDeclarationBlock(node, config, currentIndentLevel); break;
      case 'reg_declaration': formattedCodeBlock = formatRegDeclarationBlock(node, config, currentIndentLevel); break;
      case 'integer_declaration': formattedCodeBlock = formatIntegerDeclarationBlock(node, config, currentIndentLevel); break;
      case 'continuous_assign': formattedCodeBlock = formatContinuousAssignBlock(node, config, currentIndentLevel); break;
      case 'parameter_declaration': formattedCodeBlock = formatParameterDeclarationBlock(node, config, currentIndentLevel); break;
      case 'local_parameter_declaration': formattedCodeBlock = formatLocalParameterDeclarationBlock(node, config, currentIndentLevel); break;
      case 'port_declaration': formattedCodeBlock = formatPortDeclarationBlock(node, config, currentIndentLevel); break;

      // 过程块和语句
      case 'always_construct': formattedCodeBlock = formatAlwaysConstructBlock(node, config, currentIndentLevel); break;
      case 'event_control': formattedCodeBlock = formatEventControlBlock(node, config, currentIndentLevel); break;
      case 'event_expression_list': formattedCodeBlock = formatEventExpressionListBlock(node, config, currentIndentLevel); break;
      case 'event_primary': formattedCodeBlock = formatEventPrimaryBlock(node, config, currentIndentLevel); break;
      case 'statement_or_null': formattedCodeBlock = formatStatementOrNullBlock(node, config, currentIndentLevel); break;
      case 'statement': formattedCodeBlock = formatStatementBlock(node, config, currentIndentLevel); break;
      case 'statement_block': formattedCodeBlock = formatStatementBlockBlock(node, config, currentIndentLevel); break;
      case 'conditional_statement': formattedCodeBlock = formatConditionalStatementBlock(node, config, currentIndentLevel); break;
      case 'else_clause': formattedCodeBlock = formatElseClauseBlock(node, config, currentIndentLevel); break;
      case 'blocking_assignment': formattedCodeBlock = formatBlockingAssignmentBlock(node, config, currentIndentLevel); break;
      case 'non_blocking_assignment': formattedCodeBlock = formatNonBlockingAssignmentBlock(node, config, currentIndentLevel); break;
      case 'loop_statement': formattedCodeBlock = formatLoopStatementBlock(node, config, currentIndentLevel); break;
      case 'list_of_variable_assignments': formattedCodeBlock = formatListOfVariableAssignmentsBlock(node, config, currentIndentLevel); break;
      case 'variable_assignment': formattedCodeBlock = formatVariableAssignmentBlock(node, config, currentIndentLevel); break;
      case 'block_item_declaration': formattedCodeBlock = formatBlockItemDeclarationBlock(node, config, currentIndentLevel); break;

      // 表达式和标识符 (这些通常是内联的，不会添加额外的换行和缩进)
      case 'expression': formattedCodeBlock = formatExpressionBlock(node, config, currentIndentLevel); break;
      case 'hierarchical_variable_identifier': formattedCodeBlock = formatHierarchicalIdentifierBlock(node, config, currentIndentLevel); break;
      case 'variable_lvalue': formattedCodeBlock = formatVariableLvalueBlock(node, config, currentIndentLevel); break;
      case 'select_or_range': formattedCodeBlock = formatSelectOrRangeBlock(node); break;
      case 'range_expression': formattedCodeBlock = formatRangeExpressionBlock(node); break;
      case 'constant_bit_select': formattedCodeBlock = formatConstantBitSelectBlock(node); break;
      case 'net_assignment': formattedCodeBlock = formatNetAssignmentBlock(node); break;

      // 根节点特殊处理
      case 'source_text':
          node.children?.forEach(child => {
              // Source_text 的子节点就是顶层模块等，它们会负责自己的完整格式化
              formattedCodeBlock += formatASTNode(child, config, currentIndentLevel);
          });
          break;

      default:
          // 对于没有专门处理的规则节点或终端节点，直接获取其原始文本内容
          formattedCodeBlock = getRawNodeText(node);
          break;
    }

    // --- 2. 组装最终结果 ---
    let result = '';

    // 添加前导注释 (这些注释通常会自带换行)
    result += formatComments(node.leadingComments, baseIndent.repeat(currentIndentLevel));

    // 为大多数代码块添加缩进，除非它是由 formatXxxBlock 自己负责添加缩进的，或者已经是空行/注释
    // 并且 codeBlock 不以换行符开头 (因为它内部已经有了自己的换行)
    const needsInitialIndent = (node.name !== 'source_text' && node.name !== 'module_declaration' && formattedCodeBlock.trim() !== '' && !formattedCodeBlock.startsWith('\n'));
    if (needsInitialIndent) {
        result += baseIndent.repeat(currentIndentLevel);
    }
    
    result += formattedCodeBlock;

    // 添加尾随注释 (这些注释通常会自带换行)
    result += formatComments(node.trailingComments, baseIndent.repeat(currentIndentLevel));

    // --- 3. 确保行尾换行 (关键步骤) ---
    // 某些类型的节点（如声明、语句块、模块定义）结束后需要强制换行，
    // 除非 formattedCodeBlock 已经以换行结束，或者它们是表达式/内联上下文。
    const endsWithNewline = result.endsWith('\n');
    const isInlineNode = ['expression', 'event_control', 'event_expression_list', 'event_primary',
                          'variable_lvalue', 'hierarchical_variable_identifier', 'select_or_range',
                          'range_expression', 'constant_bit_select', 'net_assignment',
                          'list_of_variable_assignments', 'variable_assignment',
                          'parameter_value_assignment', 'list_of_parameter_assignments',
                          'named_parameter_assignment', 'ordered_parameter_assignment',
                          'list_of_port_connections', 'named_port_connection', 'ordered_port_connection'].includes(node.name);

    const isMajorBlockOrStatement = ['module_declaration', 'reg_declaration', 'net_declaration', 'integer_declaration',
                                     'parameter_declaration', 'local_parameter_declaration', 'port_declaration',
                                     'continuous_assign', 'module_instantiation', 'always_construct',
                                     'statement_or_null', 'statement', 'statement_block',
                                     'conditional_statement', 'else_clause', 'blocking_assignment',
                                     'non_blocking_assignment', 'loop_statement', 'module_item',
                                     'module_body'].includes(node.name);

    if (!endsWithNewline && !isInlineNode && isMajorBlockOrStatement) {
        result += '\n';
    } else if (node.name === 'source_text' && !endsWithNewline) {
        // Ensure the very end of the file has a newline if it's missing
        result += '\n';
    }

    return result;
  }

  /**
   * 基于AST对齐Verilog代码。
   * @param astRootNode - AST的根节点对象 (source_text)
   * @returns 对齐后的Verilog代码字符串
   */
  function alignFromAST(astRootNode: ASTNode, config: vscode.WorkspaceConfiguration): string {
    console.log(`[Aligner-AST] Entering alignFromAST for AST: ${astRootNode.name}`);
    let finalResult = '';

    // --- 强制处理根节点 (source_text) 的前导注释 ---
    // 这些是文件顶部的版权信息、项目信息等。
    finalResult += formatComments(astRootNode.leadingComments, '');

    // --- 处理根节点的子节点 (通过 formatASTNode 调度) ---
    finalResult += formatASTNode(astRootNode, config, 0);

    // 修复可能出现的 `<EOF>` 问题
    finalResult = finalResult.replace(/<EOF>\s*$/, '');
    
    console.log(`[Aligner-AST] alignFromAST finished. Final result length: ${finalResult.length}`);
    return finalResult;
  }

  // =========================================================================
  // 中间层：各代码块内容重构函数 (负责块内部的格式，返回完整格式化的字符串)
  // =========================================================================

  function formatModuleBlock(moduleNode: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    let moduleKeyword = '';
    let moduleIdentifier = '';
    let parameterPortList = '';
    let ansiPortList = '';
    let moduleBody = '';
    let endmoduleKeyword = '';

    moduleNode.children?.forEach(child => {
        if (child.name === 'module_keyword') {
            moduleKeyword = getRawNodeText(child);
        } else if (child.name === 'module_identifier') {
            moduleIdentifier = getRawNodeText(child);
        } else if (child.name === 'parameter_port_list') {
            parameterPortList = formatASTNode(child, config, currentIndentLevel); 
        } else if (child.name === 'ansi_port_list') {
            ansiPortList = formatASTNode(child, config, currentIndentLevel);
        } else if (child.name === 'module_body') {
            moduleBody = formatASTNode(child, config, currentIndentLevel);
        } else if (child.name === 'ENDMODULE') {
            endmoduleKeyword = getRawNodeText(child);
        }
    });

    // Module header line
    content += moduleKeyword + ' ' + moduleIdentifier;
    if (parameterPortList) {
        content += ' ' + parameterPortList.trim(); // Trim because formatASTNode for list might add its own newline
    }
    if (ansiPortList) {
        content += ' ' + ansiPortList.trim(); // Trim for same reason
    }
    content += ';\n'; // Module declaration always ends with semicolon and newline
    
    content += moduleBody; // Module body comes next, already formatted

    // Endmodule line
    content += ' '.repeat(currentIndentLevel * 4) + endmoduleKeyword;
    // Handle trailing comments of ENDMODULE token
    const endmoduleTokenNode = moduleNode.children?.find(c => c.name === 'ENDMODULE');
    if (endmoduleTokenNode && endmoduleTokenNode.trailingComments && endmoduleTokenNode.trailingComments.length > 0) {
        endmoduleTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    content += ' ' + comment.text;
                } else { // Block comment for endmodule can go on new line
                    content += '\n' + ' '.repeat(currentIndentLevel * 4) + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    content += '\n'; // Ensure endmodule always ends with a newline

    return content;
  }

  function formatModuleBodyBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      content += formatASTNode(child, config, currentIndentLevel + 1); // Module items indent by 1 level
    });
    return content;
  }

  function formatModuleItemBlock(itemNode: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const primaryChild = itemNode.children?.[0];
    if (!primaryChild) return '';
    return formatASTNode(primaryChild, config, currentIndentLevel);
  }

  // =========================================================================
  // 端口声明内容重构函数
  // =========================================================================

  function formatAnsiPortListBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    const ports: string[] = [];

    let lparenText = '';
    let rparenText = '';

    node.children?.forEach(child => {
      if (child.name === 'LPAREN') {
        lparenText = getRawNodeText(child);
      } else if (child.name === 'ansi_port_declaration') {
        ports.push(formatASTNode(child, config, currentIndentLevel + 1).trimEnd()); // Each port declaration is formatted as a single line, trim its own newline
      } else if (child.name === 'RPAREN') {
        rparenText = getRawNodeText(child);
      } else {
        content += formatASTNode(child, config, currentIndentLevel); // Other unexpected children (e.g., comments)
      }
    });
    
    // Add LPAREN before joining ports
    content += lparenText + '\n';
    content += ports.join(',\n'); // Ports separated by comma and newline
    // Add RPAREN after joining ports
    content += '\n' + ' '.repeat(currentIndentLevel * 4) + rparenText;
    
    return content;
  }

  function formatAnsiPortDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let typePart = '';
    let regKeywordPart = '';
    let signedUnsignedPart = '';
    let widthPart = '';
    let signalPart = '';
    let actualIdentifierTokenNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'port_direction') {
        typePart = getRawNodeText(child);
      } else if (child.name === 'net_type' || child.name === 'REG') {
        regKeywordPart = getRawNodeText(child);
      } else if (child.name === 'SIGNED') {
        signedUnsignedPart = getRawNodeText(child);
      } else if (child.name === 'range') {
        widthPart = formatBitWidthDeclaration(child);
      } else if (child.name === 'list_of_port_identifiers') {
        actualIdentifierTokenNode = findTerminalNode(child, 'IDENTIFIER');
        if (actualIdentifierTokenNode) {
          signalPart = getRawNodeText(actualIdentifierTokenNode);
        } else {
          signalPart = getRawNodeText(child);
        }
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Type part
    const spacesToType = Math.max(0, config.get<number>('port_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToType) + typePart);
    currentAbsoluteColumn += spacesToType + typePart.length;

    // 2. Reg/wire part
    if (regKeywordPart) {
        parts.push(' ' + regKeywordPart);
        currentAbsoluteColumn += 1 + regKeywordPart.length;
    }

    // 3. Signed/unsigned part
    const spacesToSigned = Math.max(0, config.get<number>('port_num2', 16) - currentAbsoluteColumn);
    if (signedUnsignedPart) {
        if (regKeywordPart) {
          parts.push(' ' + signedUnsignedPart);
          currentAbsoluteColumn += 1 + signedUnsignedPart.length;
        } else {
          parts.push(' '.repeat(spacesToSigned) + signedUnsignedPart);
          currentAbsoluteColumn += spacesToSigned + signedUnsignedPart.length;
        }
    }

    // 4. Width part
    const spacesToWidth = Math.max(0, config.get<number>('port_num3', 25) - currentAbsoluteColumn);
    if (widthPart) {
        parts.push(' '.repeat(spacesToWidth) + widthPart);
        currentAbsoluteColumn += spacesToWidth + widthPart.length;
    }

    // 5. Signal part
    const spacesToSignal = Math.max(0, config.get<number>('port_num4', 50) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToSignal) + signalPart);
    currentAbsoluteColumn += spacesToSignal + signalPart.length;
    
    let codeLine = parts.join('');

    // --- Append trailing comments of the actual identifier token ---
    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    
    return codeLine;
  }

  function formatPortDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length; 

    let typePart = ''; 
    let regKeywordPart = ''; 
    let signedUnsignedPart = ''; 
    let widthPart = ''; 
    let signalPart = ''; 
    let semi = ''; 
    let actualIdentifierTokenNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'port_direction') {
        typePart = getRawNodeText(child);
      } else if (child.name === 'net_type' || child.name === 'REG') {
        regKeywordPart = getRawNodeText(child);
      } else if (child.name === 'SIGNED') {
        signedUnsignedPart = getRawNodeText(child);
      } else if (child.name === 'range') {
        widthPart = formatBitWidthDeclaration(child);
      } else if (child.name === 'list_of_port_identifiers') {
        actualIdentifierTokenNode = findTerminalNode(child, 'IDENTIFIER');
        if (actualIdentifierTokenNode) {
          signalPart = getRawNodeText(actualIdentifierTokenNode);
        } else {
          signalPart = getRawNodeText(child);
        }
      } else if (child.name === 'SEMI') {
        semi = getRawNodeText(child);
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Type part
    const spacesToType = Math.max(0, config.get<number>('port_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToType) + typePart);
    currentAbsoluteColumn += spacesToType + typePart.length;

    // 2. Reg/wire part
    if (regKeywordPart) {
        parts.push(' ' + regKeywordPart);
        currentAbsoluteColumn += 1 + regKeywordPart.length;
    }

    // 3. Signed/unsigned part
    const spacesToSigned = Math.max(0, config.get<number>('port_num2', 16) - currentAbsoluteColumn);
    if (signedUnsignedPart) {
        if (regKeywordPart) {
            parts.push(' ' + signedUnsignedPart);
            currentAbsoluteColumn += 1 + signedUnsignedPart.length;
        } else {
            parts.push(' '.repeat(spacesToSigned) + signedUnsignedPart);
            currentAbsoluteColumn += spacesToSigned + signedUnsignedPart.length;
        }
    }

    // 4. Width part
    const spacesToWidth = Math.max(0, config.get<number>('port_num3', 25) - currentAbsoluteColumn);
    if (widthPart) {
        parts.push(' '.repeat(spacesToWidth) + widthPart);
        currentAbsoluteColumn += spacesToWidth + widthPart.length;
    }

    // 5. Signal part
    const spacesToSignal = Math.max(0, config.get<number>('port_num4', 50) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToSignal) + signalPart);
    currentAbsoluteColumn += spacesToSignal + signalPart.length;

    let codeLine = parts.join('');
    if (semi) {
      const spacesToSemi = Math.max(0, config.get<number>('port_num5', 80) - currentAbsoluteColumn);
      codeLine += ' '.repeat(spacesToSemi) + semi;
    }

    // Handle trailing comments of the identifier (e.g., ", // Some comment")
    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    
    return codeLine;
  }

  // =========================================================================
  // 参数端口列表内容重构函数
  // =========================================================================
  function formatParameterPortListBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    const params: string[] = [];
    
    let hashText = '';
    let lparenText = '';
    let rparenText = '';

    node.children?.forEach(child => {
      if (child.name === 'POUND') {
        hashText = getRawNodeText(child);
      } else if (child.name === 'LPAREN') {
        lparenText = getRawNodeText(child);
      } else if (child.name === 'param_assignment') {
        params.push(formatASTNode(child, config, currentIndentLevel + 1).trimEnd()); // Params indent by 1 level
      } else if (child.name === 'RPAREN') {
        rparenText = getRawNodeText(child);
      } else {
        content += formatASTNode(child, config, currentIndentLevel); // Other unexpected children
      }
    });
    
    content += hashText + lparenText + '\n';
    content += params.join(',\n');
    content += '\n' + ' '.repeat(currentIndentLevel * 4) + rparenText;
    
    return content;
  }

  function formatParamAssignmentBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let typeKeyword = ''; 
    let signedPart = ''; 
    let rangePart = ''; 
    let identifierPart = ''; 
    let valuePart = ''; 
    let actualIdentifierTokenNode: ASTNode | undefined;
    let assignmentOperator = ''; // =

    node.children?.forEach(child => {
      if (child.name === 'PARAMETER' || child.name === 'LOCALPARAM') {
        typeKeyword = getRawNodeText(child);
      } else if (child.name === 'SIGNED') {
        signedPart = getRawNodeText(child);
      } else if (child.name === 'range') {
        rangePart = formatBitWidthDeclaration(child);
      } else if (child.name === 'parameter_identifier') {
        actualIdentifierTokenNode = findTerminalNode(child, 'IDENTIFIER'); 
        if (actualIdentifierTokenNode) {
          identifierPart = getRawNodeText(actualIdentifierTokenNode);
        } else {
          identifierPart = getRawNodeText(child);
        }
      } else if (child.name === 'ASSIGN_EQ') {
        assignmentOperator = getRawNodeText(child);
      } else if (child.name === 'constant_expression') {
        valuePart = getRawNodeText(child);
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Type keyword
    const spacesToTypeKeyword = Math.max(0, config.get<number>('param_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToTypeKeyword) + typeKeyword);
    currentAbsoluteColumn += spacesToTypeKeyword + typeKeyword.length;

    // 2. Signed part
    if (signedPart) {
      parts.push(' ' + signedPart);
      currentAbsoluteColumn += 1 + signedPart.length;
    }

    // 3. Range part
    if (rangePart) {
      parts.push(' ' + rangePart);
      currentAbsoluteColumn += 1 + rangePart.length;
    }

    // 4. Identifier
    const spacesToIdentifier = Math.max(0, config.get<number>('param_num2', 25) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToIdentifier) + identifierPart);
    currentAbsoluteColumn += spacesToIdentifier + identifierPart.length;

    // 5. '=' and value
    let codeLine = parts.join('');
    if (valuePart) {
      const spacesToEquals = Math.max(0, config.get<number>('param_num3', 50) - currentAbsoluteColumn);
      codeLine += ' '.repeat(spacesToEquals) + assignmentOperator;
      codeLine += valuePart;
    }

    // Add trailing comments of the identifier (if any)
    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    return codeLine;
  }

  function formatParameterDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let typeKeyword = '';
    let signedPart = '';
    let rangePart = '';
    let assignmentsPart = '';
    let semi = '';

    node.children?.forEach(child => {
      if (child.name === 'PARAMETER' || child.name === 'LOCALPARAM') typeKeyword = getRawNodeText(child);
      else if (child.name === 'SIGNED') signedPart = getRawNodeText(child);
      else if (child.name === 'range') rangePart = formatBitWidthDeclaration(child);
      else if (child.name === 'list_of_param_assignments') assignmentsPart = formatASTNode(child, config, 0); 
      else if (child.name === 'SEMI') semi = getRawNodeText(child);
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Type keyword
    const spacesToTypeKeyword = Math.max(0, config.get<number>('param_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToTypeKeyword) + typeKeyword);
    currentAbsoluteColumn += spacesToTypeKeyword + typeKeyword.length;

    // 2. Signed part
    if (signedPart) {
      parts.push(' ' + signedPart);
      currentAbsoluteColumn += 1 + signedPart.length;
    }
    
    // 3. Range part
    if (rangePart) {
      parts.push(' ' + rangePart);
      currentAbsoluteColumn += 1 + rangePart.length;
    }

    // 4. Assignments part (contains identifier and value)
    const spacesToAssignments = Math.max(0, config.get<number>('param_num2', 25) - currentAbsoluteColumn);
    let codeLine = parts.join('');
    codeLine += ' '.repeat(spacesToAssignments) + assignmentsPart;
    currentAbsoluteColumn += spacesToAssignments + assignmentsPart.length;

    // 5. Semi
    if (semi) {
      const spacesToSemi = Math.max(0, config.get<number>('param_num4', 80) - currentAbsoluteColumn);
      codeLine += ' '.repeat(spacesToSemi) + semi;
    }
    return codeLine;
  }

  function formatLocalParameterDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    return formatParameterDeclarationBlock(node, config, currentIndentLevel);
  }

  // =========================================================================
  // 模块实例化内容重构函数
  // =========================================================================
  function formatModuleInstantiationItemBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const childNode = node.children?.[0];
    if (!childNode || childNode.name !== 'module_instantiation') return '';
    return formatASTNode(childNode, config, currentIndentLevel);
  }

  function formatModuleInstantiationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let moduleIdentifier = '';
    let parameterValueAssignment = '';
    let moduleInstances: string[] = [];
    let semi = '';

    node.children?.forEach(child => {
      if (child.name === 'module_identifier') {
        moduleIdentifier = getRawNodeText(child);
      } else if (child.name === 'parameter_value_assignment') {
        parameterValueAssignment = formatASTNode(child, config, currentIndentLevel);
      } else if (child.name === 'module_instance') {
        moduleInstances.push(formatASTNode(child, config, currentIndentLevel));
      } else if (child.name === 'SEMI') {
        semi = getRawNodeText(child);
      }
    });

    let codeLine = moduleIdentifier;
    if (parameterValueAssignment) {
      codeLine += ' ' + parameterValueAssignment.trim();
    }
    codeLine += ' ' + moduleInstances.join(', ');
    codeLine += semi;

    return codeLine;
  }

  function formatParameterValueAssignmentBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    let assignmentsContent = '';
    let hashText = '';
    let lparenText = '';
    let rparenText = '';

    node.children?.forEach(child => {
      if (child.name === 'HASH') {
        hashText = getRawNodeText(child);
      } else if (child.name === 'LPAREN') {
        lparenText = getRawNodeText(child);
      } else if (child.name === 'list_of_parameter_assignments') {
        assignmentsContent = formatASTNode(child, config, currentIndentLevel + 1);
      } else if (child.name === 'RPAREN') {
        rparenText = getRawNodeText(child);
      }
    });
    content += hashText + lparenText + '\n';
    content += assignmentsContent;
    content += '\n' + ' '.repeat(currentIndentLevel * 4) + rparenText;
    return content;
  }

  function formatListOfParameterAssignmentsBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const assignments: string[] = [];
    node.children?.forEach(child => {
      if (child.name === 'ordered_parameter_assignment') {
        assignments.push(formatASTNode(child, config, currentIndentLevel).trimEnd());
      } else if (child.name === 'named_parameter_assignment') {
        assignments.push(formatASTNode(child, config, currentIndentLevel).trimEnd());
      }
    });
    return assignments.join(',\n');
  }

  function formatOrderedParameterAssignmentBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = ' '.repeat(currentIndentLevel * 4);
    node.children?.forEach(child => {
      if (child.name === 'expression') {
        content += getRawNodeText(child);
      }
    });
    return content;
  }

  function formatNamedParameterAssignmentBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let paramName = '';
    let paramValue = '';
    let hasValue = false;
    let actualIdentifierTokenNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'parameter_identifier') {
        actualIdentifierTokenNode = findTerminalNode(child, 'IDENTIFIER');
        paramName = actualIdentifierTokenNode ? getRawNodeText(actualIdentifierTokenNode) : getRawNodeText(child);
      } else if (child.name === 'expression') {
        paramValue = getRawNodeText(child);
        hasValue = true;
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    parts.push('.');
    currentAbsoluteColumn += 1;

    parts.push(paramName);
    currentAbsoluteColumn += paramName.length;

    const spacesToValue = Math.max(0, config.get<number>('inst_param_value_col', 60) - currentAbsoluteColumn);
    if (hasValue) {
      parts.push(' '.repeat(spacesToValue) + '(' + paramValue + ')');
    } else {
      parts.push(' '.repeat(spacesToValue) + '()');
    }

    let codeLine = parts.join('');

    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    return codeLine;
  }

  function formatModuleInstanceBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let instanceName = '';
    let portConnections: string[] = [];

    node.children?.forEach(child => {
      if (child.name === 'name_of_instance') {
        instanceName = getRawNodeText(child);
      } else if (child.name === 'list_of_port_connections') {
        portConnections.push(formatASTNode(child, config, currentIndentLevel + 1));
      }
    });

    let content = instanceName + '(\n';
    content += portConnections.join(',\n') + '\n' + indentStr + ')';
    return content;
  }

  function formatListOfPortConnectionsBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const connections: string[] = [];
    node.children?.forEach(child => {
      if (child.name === 'ordered_port_connection') {
        connections.push(formatASTNode(child, config, currentIndentLevel).trimEnd());
      } else if (child.name === 'named_port_connection') {
        connections.push(formatASTNode(child, config, currentIndentLevel).trimEnd());
      }
    });
    return connections.join(',\n');
  }

  function formatOrderedPortConnectionBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = ' '.repeat(currentIndentLevel * 4);
    node.children?.forEach(child => {
      if (child.name === 'expression') {
        content += getRawNodeText(child);
      }
    });
    return content;
  }

  function formatNamedPortConnectionBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let portName = '';
    let portValue = '';
    let hasValue = false;
    let actualIdentifierTokenNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'port_identifier') {
        actualIdentifierTokenNode = findTerminalNode(child, 'IDENTIFIER');
        portName = actualIdentifierTokenNode ? getRawNodeText(actualIdentifierTokenNode) : getRawNodeText(child);
      } else if (child.name === 'expression') {
        portValue = getRawNodeText(child);
        hasValue = true;
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    parts.push('.');
    currentAbsoluteColumn += 1;

    parts.push(portName);
    currentAbsoluteColumn += portName.length;

    const spacesToValue = Math.max(0, config.get<number>('inst_port_value_col', 60) - currentAbsoluteColumn);
    if (hasValue) {
      parts.push(' '.repeat(spacesToValue) + '(' + portValue + ')');
    } else {
      parts.push(' '.repeat(spacesToValue) + '()');
    }

    let codeLine = parts.join('');

    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    return codeLine;
  }


  // =========================================================================
  // always 块内容重构函数
  // =========================================================================

  function formatAlwaysConstructBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let headerText = 'always ';
    let bodyString = '';

    node.children?.forEach(child => {
      if (child.name === 'event_control') {
        headerText += formatASTNode(child, config, currentIndentLevel);
      } else if (child.name === 'statement_or_null') {
        bodyString = formatASTNode(child, config, currentIndentLevel);
      }
    });

    let content = headerText;
    // If the body is a 'begin...end' block, put 'begin' on the same line if desired, then newline.
    // Otherwise, it's a single statement, already formatted by formatASTNode.
    if (bodyString.trimStart().startsWith('begin\n')) { 
        content += ' ' + bodyString;
    } else {
        content += bodyString;
    }
    return content;
  }

  function formatEventControlBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      if (child.name === 'AT') {
        content += getRawNodeText(child);
      } else if (child.name === 'STAR') {
        content += getRawNodeText(child);
      } else if (child.name === 'LPAREN') {
        content += getRawNodeText(child);
      } else if (child.name === 'RPAREN') {
        content += getRawNodeText(child);
      } else if (child.name === 'event_expression_list') {
        content += formatASTNode(child, config, currentIndentLevel);
      } else {
        content += getRawNodeText(child); 
      }
    });
    return content;
  }

  function formatEventExpressionListBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      content += formatASTNode(child, config, currentIndentLevel);
      if (child.name === 'COMMA') {
        content += ' ';
      } else if (child.name === 'OR') {
        content += ' ';
      }
    });
    return content.trim(); 
  }

  function formatEventPrimaryBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      if (child.name === 'POSEDGE' || child.name === 'NEGEDGE') {
        content += `${getRawNodeText(child)} `;
      } else if (child.name === 'expression') {
        content += formatASTNode(child, config, currentIndentLevel);
      } else {
        content += getRawNodeText(child);
      }
    });
    return content;
  }

  // =========================================================================
  // 语句内容重构函数
  // =========================================================================

  function formatStatementOrNullBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      if (child.name === 'statement') {
        content += formatASTNode(child, config, currentIndentLevel);
      } else if (child.name === 'SEMI') { 
        content += ' '.repeat(currentIndentLevel * 4) + getRawNodeText(child) + '\n'; // Semi for null statement
      } else {
        content += formatASTNode(child, config, currentIndentLevel);
      }
    });
    return content;
  }

  function formatStatementBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      content += formatASTNode(child, config, currentIndentLevel);
    });
    return content;
  }

  function formatStatementBlockBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let content = '';
    let statements: ASTNode[] = [];
    let hasBegin = false;
    let hasEnd = false;
    let beginText = '';
    let endText = '';

    node.children?.forEach(child => {
        if (child.name === 'BEGIN') {
            hasBegin = true;
            beginText = getRawNodeText(child);
        } else if (child.name === 'END') {
            hasEnd = true;
            endText = getRawNodeText(child);
        } else if (child.name === 'block_item_declaration' || child.name === 'statement_or_null') {
            statements.push(child);
        }
    });

    const isSingleSimpleStatementBlock = hasBegin && hasEnd && statements.length === 1 &&
                                         statements[0].name === 'statement_or_null' &&
                                         statements[0].children && statements[0].children.length === 1 &&
                                         statements[0].children[0].name === 'statement' &&
                                         statements[0].children[0].children && statements[0].children[0].children.length === 1 &&
                                         ['blocking_assignment', 'non_blocking_assignment', 'assign_statement', 'deassign_statement'].includes(statements[0].children[0].children[0].name);

    if (isSingleSimpleStatementBlock) {
        content = formatASTNode(statements[0], config, currentIndentLevel); // No begin/end, just the statement
    } else {
        if (hasBegin) {
            content += beginText + '\n'; // 'begin' on its own line
        }
        statements.forEach(child => {
            content += formatASTNode(child, config, currentIndentLevel + 1); // Contents indent by one more level
        });
        if (hasEnd) {
            content += indentStr + endText + '\n'; // 'end' with its own indent and newline
        }
    }
    return content;
  }

  function formatConditionalStatementBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let content = 'if ';
    let conditionPart = '';
    let ifBodyNode: ASTNode | undefined;
    let elseClauseNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'IF') {
        // Handled by content init
      } else if (child.name === 'LPAREN') {
        conditionPart += getRawNodeText(child);
      } else if (child.name === 'RPAREN') {
        conditionPart += getRawNodeText(child);
      } else if (child.name === 'expression') {
        conditionPart += formatASTNode(child, config, 0); 
      } else if (child.name === 'statement_or_null') {
        if (!ifBodyNode) { 
            ifBodyNode = child;
        }
      } else if (child.name === 'else_clause') {
        elseClauseNode = child;
      }
    });

    content += conditionPart;
    if (ifBodyNode) {
      const ifBodyString = formatASTNode(ifBodyNode, config, currentIndentLevel);
      if (ifBodyString.trimStart().startsWith('begin\n')) { 
          content += ' ' + ifBodyString; 
      } else {
          content += ifBodyString; 
      }
    }

    if (elseClauseNode) {
      content += formatASTNode(elseClauseNode, config, currentIndentLevel);
    }
    return content;
  }

  function formatElseClauseBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let content = indentStr + 'else ';
    let elseConditionPart = ''; 
    let elseBodyNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'ELSE') {
        // Handled by content init
      } else if (child.name === 'IF') { 
        elseConditionPart += 'if ';
      } else if (child.name === 'LPAREN') {
        elseConditionPart += getRawNodeText(child);
      } else if (child.name === 'RPAREN') {
        elseConditionPart += getRawNodeText(child);
      } else if (child.name === 'expression') {
        elseConditionPart += formatASTNode(child, config, 0); 
      } else if (child.name === 'statement_or_null') {
        elseBodyNode = child;
      }
    });

    content += elseConditionPart.trim();
    if (elseBodyNode) {
      const elseBodyString = formatASTNode(elseBodyNode, config, currentIndentLevel);
      if (elseBodyString.trimStart().startsWith('begin\n')) { 
          content += ' ' + elseBodyString; 
      } else {
          content += elseBodyString; 
      }
    }
    return content;
  }

  function formatBlockingAssignmentBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let content = indentStr;
    node.children?.forEach(child => {
      content += formatASTNode(child, config, currentIndentLevel);
    });
    return content;
  }

  function formatNonBlockingAssignmentBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let content = indentStr;
    node.children?.forEach(child => {
      content += formatASTNode(child, config, currentIndentLevel);
    });
    return content;
  }

  // =========================================================================
  // 表达式和标识符内容重构函数
  // =========================================================================

  function formatExpressionBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    let prevChildContent = ''; 

    node.children?.forEach(child => {
      const childContent = formatASTNode(child, config, currentIndentLevel); 
      if (childContent.length > 0) {
        const lastCharOfPrev = prevChildContent.slice(-1);
        const firstCharOfChild = childContent.trimStart().charAt(0);

        const needsSpace = (
          prevChildContent.length > 0 &&
          prevChildContent.trim() !== '' &&
          childContent.trim() !== '' &&
          !['(', '[', '{', '.', ',', ';', ':', '`', '~', '!'].includes(firstCharOfChild) && 
          !['(', '[', '{'].includes(lastCharOfPrev) &&
          !['.', ','].includes(lastCharOfPrev) &&
          (/\w/.test(lastCharOfPrev) && /\w/.test(firstCharOfChild))
        );

        if (needsSpace) {
          content += ' ';
        }
        content += childContent;
        prevChildContent = childContent;
      }
    });
    return content;
  }

  function formatHierarchicalIdentifierBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    let prevChildContent = '';
    node.children?.forEach(child => {
      const childContent = formatASTNode(child, config, currentIndentLevel);
      if (childContent.length > 0) {
        if (child.name !== 'DOT' && prevChildContent.endsWith('.') && childContent.length > 0) {
          // No space
        } else if (prevChildContent.length > 0 && prevChildContent.trim() !== '' && childContent.trim() !== '') {
          content += ' ';
        }
        content += childContent;
        prevChildContent = childContent;
      }
    });
    return content;
  }

  function formatVariableLvalueBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    let first = true;
    node.children?.forEach(child => {
      if (child.name === 'COMMA') {
        content += getRawNodeText(child) + ' '; 
        first = true; 
      } else {
        if (!first) {
          content += ' '; 
        }
        content += formatASTNode(child, config, currentIndentLevel);
        first = false;
      }
    });
    return content;
  }

  function formatSelectOrRangeBlock(node: ASTNode): string {
    let content = '';
    node.children?.forEach(child => {
      content += getRawNodeText(child);
    });
    return content;
  }

  function formatRangeExpressionBlock(node: ASTNode): string {
    let content = '';
    node.children?.forEach(child => {
      content += getRawNodeText(child);
    });
    return content;
  }

  function formatConstantBitSelectBlock(node: ASTNode): string {
    let content = '';
    node.children?.forEach(child => {
      content += getRawNodeText(child);
    });
    return content;
  }

  // =========================================================================
  // 循环语句内容重构函数
  // =========================================================================

  function formatLoopStatementBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = 'for (';
    let initial = '';
    let condition = '';
    let iteration = '';
    let bodyNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'FOR') {
        // Handled by content init
      } else if (child.name === 'LPAREN') {
        // Handled by content init
      } else if (child.name === 'list_of_variable_assignments' && !initial) {
        initial = formatASTNode(child, config, 0); 
      } else if (child.name === 'expression' && !condition) {
        condition = formatASTNode(child, config, 0);
      } else if (child.name === 'list_of_variable_assignments' && initial && !iteration) {
        iteration = formatASTNode(child, config, 0);
      } else if (child.name === 'RPAREN') {
        content += getRawNodeText(child);
      } else if (child.name === 'statement_or_null') {
        bodyNode = child;
      } else if (child.name === 'SEMI') {
        content += getRawNodeText(child) + ' '; 
      }
    });

    content += `${initial.trim()}; ${condition.trim()}; ${iteration.trim()}) `;
    if (bodyNode) {
      content += formatASTNode(bodyNode, config, currentIndentLevel); 
    }
    return content;
  }

  function formatListOfVariableAssignmentsBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    const assignments: string[] = [];
    node.children?.forEach(child => {
      if (child.name === 'variable_assignment') {
        assignments.push(formatASTNode(child, config, currentIndentLevel));
      }
    });
    content += assignments.join(', ');
    return content;
  }

  function formatVariableAssignmentBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      content += formatASTNode(child, config, currentIndentLevel);
    });
    return content;
  }

  // =========================================================================
  // 块内声明内容
  // =========================================================================
  function formatBlockItemDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    let content = '';
    node.children?.forEach(child => {
      content += formatASTNode(child, config, currentIndentLevel);
    });
    return content;
  }

  // =========================================================================
  // 模块内部声明内容 (wire, reg, integer)
  // =========================================================================
  function formatNetDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let netTypePart = '';
    let signedUnsignedPart = '';
    let widthPart = '';
    let identifiersPart = '';
    let semi = '';
    let actualIdentifierTokenNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'net_type') netTypePart = getRawNodeText(child);
      else if (child.name === 'SIGNED') signedUnsignedPart = getRawNodeText(child);
      else if (child.name === 'range') {
        widthPart = formatBitWidthDeclaration(child);
      }
      else if (child.name === 'list_of_net_identifiers_or_assignments') {
        const identifiersList = child.children?.filter(c => c.name === 'net_assignment' || c.name === 'net_identifier');
        if (identifiersList && identifiersList.length > 0) {
            const lastIdentifierChild = identifiersList[identifiersList.length - 1];
            actualIdentifierTokenNode = findTerminalNode(lastIdentifierChild, 'IDENTIFIER');
        }
        identifiersPart = formatASTNode(child, config, 0); // Reconstruct the list itself
      } else if (child.name === 'SEMI') {
        semi = getRawNodeText(child);
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Net type
    const spacesToNetType = Math.max(0, config.get<number>('signal_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToNetType) + netTypePart);
    currentAbsoluteColumn += spacesToNetType + netTypePart.length;

    // 2. Signed/unsigned
    const spacesToSigned = Math.max(0, config.get<number>('signal_num2', 16) - currentAbsoluteColumn);
    if (signedUnsignedPart) {
      parts.push(' '.repeat(spacesToSigned) + signedUnsignedPart);
      currentAbsoluteColumn += spacesToSigned + signedUnsignedPart.length;
    }

    // 3. Width
    const spacesToWidth = Math.max(0, config.get<number>('signal_num3', 25) - currentAbsoluteColumn);
    if (widthPart) {
      parts.push(' '.repeat(spacesToWidth) + widthPart);
      currentAbsoluteColumn += spacesToWidth + widthPart.length;
    }

    // 4. Identifiers
    const spacesToIdentifiers = Math.max(0, config.get<number>('signal_num4', 50) - currentAbsoluteColumn);
    let codeLine = parts.join('');
    codeLine += ' '.repeat(spacesToIdentifiers) + identifiersPart;
    currentAbsoluteColumn += spacesToIdentifiers + identifiersPart.length;

    // 5. Semi
    if (semi) {
      const spacesToSemi = Math.max(0, config.get<number>('signal_num5', 80) - currentAbsoluteColumn);
      codeLine += ' '.repeat(spacesToSemi) + semi;
    }

    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    return codeLine;
  }

  function formatRegDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let regKeyword = '';
    let signedPart = '';
    let widthPart = '';
    let identifiersPart = '';
    let semi = '';
    let actualIdentifierTokenNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'REG') regKeyword = getRawNodeText(child);
      else if (child.name === 'SIGNED') signedPart = getRawNodeText(child);
      else if (child.name === 'range') {
        widthPart = formatBitWidthDeclaration(child);
      }
      else if (child.name === 'list_of_variable_identifiers') {
        const identifiersList = child.children?.filter(c => c.name === 'variable_identifier');
        if (identifiersList && identifiersList.length > 0) {
            const lastIdentifierChild = identifiersList[identifiersList.length - 1];
            actualIdentifierTokenNode = findTerminalNode(lastIdentifierChild, 'IDENTIFIER');
        }
        identifiersPart = formatASTNode(child, config, 0); 
      }
      else if (child.name === 'SEMI') {
        semi = getRawNodeText(child);
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Reg keyword
    const spacesToRegKeyword = Math.max(0, config.get<number>('signal_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToRegKeyword) + regKeyword);
    currentAbsoluteColumn += spacesToRegKeyword + regKeyword.length;

    // 2. Signed part
    const spacesToSigned = Math.max(0, config.get<number>('signal_num2', 16) - currentAbsoluteColumn);
    if (signedPart) {
      parts.push(' '.repeat(spacesToSigned) + signedPart);
      currentAbsoluteColumn += spacesToSigned + signedPart.length;
    }

    // 3. Width
    const spacesToWidth = Math.max(0, config.get<number>('signal_num3', 25) - currentAbsoluteColumn);
    if (widthPart) {
      parts.push(' '.repeat(spacesToWidth) + widthPart);
      currentAbsoluteColumn += spacesToWidth + widthPart.length;
    }

    // 4. Identifiers
    const spacesToIdentifiers = Math.max(0, config.get<number>('signal_num4', 50) - currentAbsoluteColumn);
    let codeLine = parts.join('');
    codeLine += ' '.repeat(spacesToIdentifiers) + identifiersPart;
    currentAbsoluteColumn += spacesToIdentifiers + identifiersPart.length;

    // 5. Semi
    if (semi) {
      const spacesToSemi = Math.max(0, config.get<number>('signal_num5', 80) - currentAbsoluteColumn);
      codeLine += ' '.repeat(spacesToSemi) + semi;
    }

    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    return codeLine;
  }

  function formatIntegerDeclarationBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let integerKeyword = '';
    let widthPart = '';
    let identifiersPart = '';
    let semi = '';
    let actualIdentifierTokenNode: ASTNode | undefined;

    node.children?.forEach(child => {
      if (child.name === 'INTEGER') integerKeyword = getRawNodeText(child);
      else if (child.name === 'range') {
        widthPart = formatBitWidthDeclaration(child);
      }
      else if (child.name === 'list_of_variable_identifiers') {
        const identifiersList = child.children?.filter(c => c.name === 'variable_identifier');
        if (identifiersList && identifiersList.length > 0) {
            const lastIdentifierChild = identifiersList[identifiersList.length - 1];
            actualIdentifierTokenNode = findTerminalNode(lastIdentifierChild, 'IDENTIFIER');
        }
        identifiersPart = formatASTNode(child, config, 0);
      }
      else if (child.name === 'SEMI') {
        semi = getRawNodeText(child);
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Integer keyword
    const spacesToIntegerKeyword = Math.max(0, config.get<number>('signal_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToIntegerKeyword) + integerKeyword);
    currentAbsoluteColumn += spacesToIntegerKeyword + integerKeyword.length;

    // 2. Width (if applicable for integer)
    const spacesToWidth = Math.max(0, config.get<number>('signal_num3', 25) - currentAbsoluteColumn);
    if (widthPart) {
      parts.push(' '.repeat(spacesToWidth) + widthPart);
      currentAbsoluteColumn += spacesToWidth + widthPart.length;
    }

    // 3. Identifiers
    const spacesToIdentifiers = Math.max(0, config.get<number>('signal_num4', 50) - currentAbsoluteColumn);
    let codeLine = parts.join('');
    codeLine += ' '.repeat(spacesToIdentifiers) + identifiersPart;
    currentAbsoluteColumn += spacesToIdentifiers + identifiersPart.length;

    // 4. Semi
    if (semi) {
      const spacesToSemi = Math.max(0, config.get<number>('signal_num5', 80) - currentAbsoluteColumn);
      codeLine += ' '.repeat(spacesToSemi) + semi;
    }

    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    return codeLine;
  }

  function formatContinuousAssignBlock(node: ASTNode, config: vscode.WorkspaceConfiguration, currentIndentLevel: number): string {
    const indentStr = ' '.repeat(currentIndentLevel * 4);
    let currentAbsoluteColumn = indentStr.length;

    let assignKeyword = '';
    let assignmentsPart = ''; 
    let semi = '';
    let actualIdentifierTokenNode: ASTNode | undefined; // For last identifier's trailing comment

    node.children?.forEach(child => {
      if (child.name === 'ASSIGN') assignKeyword = getRawNodeText(child);
      else if (child.name === 'list_of_net_assignments') {
        const netAssignmentNodes = child.children?.filter(c => c.name === 'net_assignment');
        if (netAssignmentNodes && netAssignmentNodes.length > 0) {
            const lastAssignment = netAssignmentNodes[netAssignmentNodes.length - 1];
            const lvalueNode = lastAssignment.children?.find(n => n.name === 'net_lvalue');
            if (lvalueNode) {
                actualIdentifierTokenNode = findTerminalNode(lvalueNode, 'IDENTIFIER');
            }
        }

        const netAssignments: string[] = [];
        child.children?.forEach(netAssignChild => {
          if (netAssignChild.name === 'net_assignment') {
            netAssignments.push(formatNetAssignmentBlock(netAssignChild)); 
          }
        });
        assignmentsPart = netAssignments.join(', ');
      } else if (child.name === 'SEMI') {
        semi = getRawNodeText(child);
      }
    });

    const parts: string[] = [];
    parts.push(indentStr);
    currentAbsoluteColumn = indentStr.length;

    // 1. Assign keyword
    const spacesToAssignKeyword = Math.max(0, config.get<number>('assign_num1', 4) - currentAbsoluteColumn);
    parts.push(' '.repeat(spacesToAssignKeyword) + assignKeyword);
    currentAbsoluteColumn += spacesToAssignKeyword + assignKeyword.length;

    // 2. Assignments part
    const spacesToAssignments = Math.max(0, config.get<number>('assign_num2', 12) - currentAbsoluteColumn);
    let codeLine = parts.join('');
    codeLine += ' '.repeat(spacesToAssignments) + assignmentsPart;
    currentAbsoluteColumn += spacesToAssignments + assignmentsPart.length;

    // 3. Semi
    if (semi) {
      codeLine += semi; 
    }

    if (actualIdentifierTokenNode?.trailingComments && actualIdentifierTokenNode.trailingComments.length > 0) {
        actualIdentifierTokenNode.trailingComments.forEach(comment => {
            if (!processedCommentIndices.has(comment.originalTokenIndex)) {
                if (comment.type === 'line') {
                    codeLine += ' ' + comment.text;
                } else {
                    codeLine += '\n' + indentStr + comment.text;
                }
                processedCommentIndices.add(comment.originalTokenIndex);
            }
        });
    }
    return codeLine;
  }

  function formatNetAssignmentBlock(node: ASTNode): string {
    let lvalue = '';
    let expression = '';
    node.children?.forEach(child => {
      if (child.name === 'net_lvalue') {
        lvalue = getRawNodeText(child);
      } else if (child.name === 'expression') {
        expression = getRawNodeText(child);
      }
    });
    return `${lvalue}${getRawNodeText({name: 'ASSIGN_EQ', value: '='})}${expression}`; 
  }

  // =========================================================================
  // 辅助函数
  // =========================================================================

  /**
   * 对齐位宽声明的内部 (如 [31:0] -> [31: 0])
   * @param rangeNode - AST range 节点
   * @returns 对齐后的位宽字符串 (例如 "[31: 0]")
   */
  function formatBitWidthDeclaration(rangeNode: ASTNode): string {
    const upbound = config.get('upbound', 2);
    const lowbound = config.get('lowbound', 2);

    let msb = '';
    let lsb = '';
    let hasColon = false;

    rangeNode.children?.forEach(child => {
      if (child.name === 'LBRACK' || child.name === 'RBRACK') { /* ignore */ }
      else if (child.name === 'expression' && !hasColon) {
        msb = getRawNodeText(child);
      } else if (child.name === 'COLON') {
        hasColon = true;
      } else if (child.name === 'expression' && hasColon) {
        lsb = getRawNodeText(child);
      }
    });

    const alignedMsb = msb.padStart(Math.max(upbound, msb.length), ' ');
    const alignedLsb = lsb.padEnd(Math.max(lowbound, lsb.length), ' ');

    return `[${alignedMsb}:${alignedLsb}]`;
  }

  // --- 执行 AST 对齐 ---
  return alignFromAST(ast, config);
} // <-- alignVerilogCode 函数的结束括号

// =========================================================================
// 旧的基于正则表达式的对齐函数 (保持不变，作为顶层函数，但不再导出)
// =========================================================================

/**
 * 对齐 Verilog 代码 (仅限正则表达式模式)
 * @param text - 输入的文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignVerilogCodeRegexOnly(text: string, config: vscode.WorkspaceConfiguration): string {
  console.log(`[Aligner-Regex] alignVerilogCodeRegexOnly called for lines: ${text.split('\n').length}`);
  const lines = text.split('\n');
  const alignedLines = lines.map(line => {
    if (line.trim().startsWith('/*') || line.trim().startsWith('//') || line.trim() === '') {
      return line;
    }
    if (
      line.trim().startsWith('module') || line.trim().startsWith('function') ||
      line.trim().startsWith('always') || line.trim().startsWith('initial') ||
      line.trim().startsWith('task') || line.trim().startsWith('endmodule') ||
      line.trim().startsWith('endfunction') || line.trim().startsWith('endtask') ||
      line.trim().startsWith('endalways') || line.trim().startsWith('endinitial') ||
      line.trim().startsWith('begin') || line.trim().startsWith('end') ||
      line.trim().startsWith('if') || line.trim().startsWith('else') ||
      line.trim().startsWith('case') || line.trim().startsWith('endcase') ||
      line.trim().startsWith('for') || line.trim().startsWith('while') ||
      line.trim().startsWith('repeat') || line.trim().startsWith('fork') ||
      line.trim().startsWith('join')
    ) {
      return line;
    }

    const isTwoDimArray = /^\s*(reg|wire)\s*(signed|unsigned)?\s*(\[[^\]]+\])\s*[^;,\s]+\s*(\[[^\]]+\])/.test(line);
    if (isTwoDimArray) {
        return alignTwoDimArrayDeclaration(line, config);
    }
    if (line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) {
        return alignPortDeclaration(line, config);
    }
    if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer') || line.trim().startsWith('real')) {
        return alignRegWireIntegerDeclaration(line, config);
    }
    if (line.trim().startsWith('localparam') || line.trim().startsWith('parameter')) {
        return alignParamDeclaration(line, config);
    }
    if (line.trim().startsWith('assign')) {
        return alignAssignDeclaration(line, config);
    }
    if (line.trim().startsWith('.')) {
        return alignInstanceSignal(line, config);
    }
    return line;
  });
  return alignedLines.join('\n');
}

function alignPortDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const port_num1 = config.get<number>('port_num1', 4 );
  const port_num2 = config.get<number>('port_num2', 16);
  const port_num3 = config.get<number>('port_num3', 25);
  const port_num4 = config.get<number>('port_num4', 50);
  const port_num5 = config.get<number>('port_num5', 80);

  const regex = /^\s*(input\b|output\b|inout\b)\s*(reg|wire)?\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type            = match[1].trim();
  const regKeyword      = (match[2] || '').trim();
  const signedUnsigned  = (match[3] || '').trim();
  const width           = (match[4] || '').trim();
  const signal          = match[5].trim();
  const endSymbol       = (match[6] || '').trim();
  const comment         = (match[7] || '').trim();

  const alignedWidth = width ? alignBitWidthDeclaration(width, config) : '';

  let currentPos = 0;
  const parts: string[] = [];

  const typeSpaces = Math.max(0, port_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  if (regKeyword) {
      parts.push(' ' + regKeyword);
      currentPos += 1 + regKeyword.length;
  }

  const signedSpaces = Math.max(0, port_num2 - currentPos);
  if (signedUnsigned) {
      parts.push(' '.repeat(signedSpaces) + signedUnsigned);
      currentPos += signedSpaces + signedUnsigned.length;
  }

  const widthSpaces = Math.max(0, port_num3 - currentPos);
  if (alignedWidth) {
      parts.push(' '.repeat(widthSpaces) + alignedWidth);
      currentPos += widthSpaces + alignedWidth.length;
  }

  const signalSpaces = Math.max(0, port_num4 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  const endSymbolAndCommentSpaces = Math.max(0, port_num5 - currentPos);
  parts.push(' '.repeat(endSymbolAndCommentSpaces) + endSymbol + comment);

  return parts.join('');
}

function alignRegWireIntegerDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const signal_num1 = config.get<number>('signal_num1',  4);
  const signal_num2 = config.get<number>('signal_num2', 16);
  const signal_num3 = config.get<number>('signal_num3', 25);
  const signal_num4 = config.get<number>('signal_num4', 50);
  const signal_num5 = config.get<number>('signal_num5', 80);

  const regex = /^\s*(reg\b|wire\b|integer\b|real\b)\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;]\s*)?(.*)/;
  const match = line.match(regex);

  const type            = match![1].trim();
  const signedUnsigned  = (match![2] || '').trim();
  const width           = (match![3] || '').trim();
  const signal          = match![4].trim();
  const endSymbol       = (match![5] || '').trim();
  const comment         = (match![6] || '').trim();

  const alignedWidth = width ? alignBitWidthDeclaration(width, config) : '';

  let currentPos = 0;
  const parts: string[] = [];

  const typeSpaces = Math.max(0, signal_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  const signedSpaces = Math.max(0, signal_num2 - currentPos);
  if (signedUnsigned) {
      parts.push(' '.repeat(signedSpaces) + signedUnsigned);
      currentPos += signedSpaces + signedUnsigned.length;
  }

  const widthSpaces = Math.max(0, signal_num3 - currentPos);
  if (alignedWidth) {
      parts.push(' '.repeat(widthSpaces) + alignedWidth);
      currentPos += widthSpaces + alignedWidth.length;
  }

  const signalSpaces = Math.max(0, signal_num4 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  const endSymbolAndCommentSpaces = Math.max(0, signal_num5 - currentPos);
   parts.push(' '.repeat(endSymbolAndCommentSpaces) + endSymbol + comment);

  return parts.join('');
}

function alignParamDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const param_num1 = config.get<number>('param_num1', 4 );
  const param_num2 = config.get<number>('param_num2', 25);
  const param_num3 = config.get<number>('param_num3', 50);
  const param_num4 = config.get<number>('param_num4', 80);

  const regex = /^\s*(localparam\b|parameter\b)\s+([^\s=]+)\s*=\s*([^;,\/]+)\s*([;,])?\s*(.*)/;

  const match = line.match(regex);
  if (!match) return line;

  const type      = match[1].trim();
  const signal    = match[2].trim();
  const value     = match[3].trim();
  const endSymbol = (match[4] || '').trim();
  const comment   = (match[5] || '').trim();

  let currentPos = 0;
  const parts: string[] = [];

  const typeSpaces = Math.max(0, param_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  const signalSpaces = Math.max(0, param_num2 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  const equalsSpaces = Math.max(0, param_num3 - currentPos);
   parts.push(' '.repeat(equalsSpaces) + '=');
   currentPos += equalsSpaces + 1;

  parts.push(' ');
  currentPos += 1;

  parts.push(value);
  currentPos += value.length;

  const endSymbolAndCommentSpaces = Math.max(0, param_num4 - currentPos);
  parts.push(' '.repeat(endSymbolAndCommentSpaces) + endSymbol + comment);

  return parts.join('');
}

function alignAssignDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const assign_num1 = config.get<number>('assign_num1', 4 );
  const assign_num2 = config.get<number>('assign_num2', 12);
  const assign_num3 = config.get<number>('assign_num3', 30);

  const regex = /^\s*assign\b\s+([^\s=]+)\s*=\s*([^;]+)\s*([;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const signal    = match[1].trim();
  const value     = match[2].trim();
  const endSymbol = (match[3] || '').trim();
  const comment   = (match[4] || '').trim();

  let currentPos = 0;
  const parts: string[] = [];

  const assignSpaces = Math.max(0, assign_num1 - currentPos);
  parts.push(' '.repeat(assignSpaces) + 'assign');
  currentPos += assignSpaces + 'assign'.length;

  const signalSpaces = Math.max(0, assign_num2 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  const equalsSpaces = Math.max(0, assign_num3 - currentPos);
  parts.push(' '.repeat(equalsSpaces) + '=');
  currentPos += equalsSpaces + 1;

  parts.push(' ');
  currentPos += 1;

  parts.push(value);
  currentPos += value.length;

  parts.push(endSymbol + comment);

  return parts.join('');
}

function alignInstanceSignal(line: string, config: vscode.WorkspaceConfiguration): string {
  const inst_num1 = config.get<number>('inst_num1', 8 );
  const inst_num2 = config.get<number>('inst_num2', 40);
  const inst_num3 = config.get<number>('inst_num3', 80);

  const regex = /^\s*\.([^\s]+)\s*([^(]*)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const signal      = match[1].trim();
  const connection  = match[2].trim();
  const endSymbol   = (match[3] || '').trim();
  const comment     = (match[4] || '').trim();

  let currentPos = 0;
  const parts: string[] = [];

  const dotSignalSpaces = Math.max(0, inst_num1 - currentPos);
  parts.push(' '.repeat(dotSignalSpaces) + `.${signal}`);
  currentPos += dotSignalSpaces + 1 + signal.length;

  const openParenSpaces = Math.max(0, inst_num2 - currentPos);
  parts.push(' '.repeat(openParenSpaces) + '(');
  currentPos += openParenSpaces + 1;

  parts.push(connection);
  currentPos += connection.length;

  const closeParenSpaces = Math.max(0, inst_num3 - currentPos);
  parts.push(' '.repeat(closeParenSpaces) + ')');
  currentPos += closeParenSpaces + 1;

  parts.push(endSymbol + comment);

  return parts.join('');
}

function alignBitWidthDeclaration(bitwidthString: string, config: vscode.WorkspaceConfiguration): string {
  const upbound = config.get('upbound', 2);
  const lowbound = config.get('lowbound', 2);

  const regex = /\[\s*([^:]+)\s*:\s*([^\]]+)\s*\]/;
  const match = bitwidthString.match(regex);

  if (!match) {
    return bitwidthString;
  }

  const up = match[1].trim();
  const low = match[2].trim();

  const alignedUp = up.padStart(Math.max(upbound, up.length), ' ');
  const alignedLow = low.padEnd(Math.max(lowbound, low.length), ' ');

  return `[${alignedUp}:${alignedLow}]`;
}

function alignTwoDimArrayDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const array_num1 = config.get<number>('array_num1', 4 );
  const array_num2 = config.get<number>('array_num2', 16);
  const array_num3 = config.get<number>('array_num3', 25);
  const array_num4 = config.get<number>('array_num4', 50);
  const array_num5 = config.get<number>('array_num5', 60);
  const array_num6 = config.get<number>('array_num6', 80);

  const regex = /^\s*(reg\b|wire\b)\s*(signed|unsigned)?\s*(\[[^\]]+\])\s*([^;,\s]+)\s*(\[[^\]]+\])\s*([;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = (match[1] || '').trim();
  const signedUnsigned = (match[2] || '').trim();
  const width1 = (match[3] || '').trim();
  const signal = (match[4] || '').trim();
  const width2 = (match[5] || '').trim();
  const endSymbol = (match[6] || '').trim();
  const comment = (match[7] || '').trim();

  const alignedWidth1 = width1 ? alignBitWidthDeclaration(width1, config) : '';
  const alignedWidth2 = width2 ? alignBitWidthDeclaration(width2, config) : '';

  let currentPos = 0;
  const parts: string[] = [];

  const typeSpaces = Math.max(0, array_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  const signedSpaces = Math.max(0, array_num2 - currentPos);
  if (signedUnsigned) {
      parts.push(' '.repeat(signedSpaces) + signedUnsigned);
      currentPos += signedSpaces + signedUnsigned.length;
  }

  const width1Spaces = Math.max(0, array_num3 - currentPos);
  if (alignedWidth1) {
      parts.push(' '.repeat(width1Spaces) + alignedWidth1);
      currentPos += width1Spaces + alignedWidth1.length;
  }

  const signalSpaces = Math.max(0, array_num4 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  const width2Spaces = Math.max(0, array_num5 - currentPos);
  if (alignedWidth2) {
      parts.push(' '.repeat(width2Spaces) + alignedWidth2);
      currentPos += width2Spaces + alignedWidth2.length;
  }

  const endSymbolSpaces = Math.max(0, array_num6 - currentPos);
  parts.push(' '.repeat(endSymbolSpaces) + endSymbol);
  currentPos += endSymbolSpaces + endSymbol.length;

  if (comment) {
    parts.push(' ' + comment);
  }

  return parts.join('');
}
