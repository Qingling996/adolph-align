import * as vscode from 'vscode';
import * as fs from 'fs';

// =========================================================================
// 接口定义 (保持不变)
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

interface FormattingContext {
    processedCommentIndices: Set<number>;
}

// =========================================================================
// 插件入口函数 (保持不变)
// =========================================================================
export function alignVerilogCodeDispatcher(
    text: string, 
    config: vscode.WorkspaceConfiguration, 
    useASTMode: boolean, 
    astFilePath?: string
): string {
    console.log(`[Aligner] Dispatcher called. useASTMode: ${useASTMode}`);

    if (useASTMode && astFilePath && fs.existsSync(astFilePath)) {
        try {
            const astContent = fs.readFileSync(astFilePath, 'utf-8');
            const ast = JSON.parse(astContent);
            console.log(`[Aligner] AST loaded successfully from: ${astFilePath}`);
            return alignFromAST(ast, config);
        } catch (error: any) {
            console.error(`[Aligner] Error processing AST file: ${error.message}`);
            vscode.window.showErrorMessage('AST文件解析失败，降级到正则表达式对齐模式。');
            return alignVerilogCodeRegexOnly(text, config);
        }
    } else {
        console.log('[Aligner] Using Regex mode.');
        return alignVerilogCodeRegexOnly(text, config);
    }
}


// =========================================================================
// AST 对齐核心逻辑 - 函数定义区
// =========================================================================

function alignFromAST(astRootNode: ASTNode, config: vscode.WorkspaceConfiguration): string {
    console.log(`[Aligner-AST] Starting alignment for root node: ${astRootNode.name}`);
    const context: FormattingContext = {
        processedCommentIndices: new Set<number>()
    };
    return formatASTNode(astRootNode, config, 0, context).trim() + '\n';
}

function findChild(node: ASTNode, name: string): ASTNode | undefined {
    return node.children?.find(child => child.name === name);
}

function findAllChildren(node: ASTNode, name: string): ASTNode[] {
    return node.children?.filter(child => child.name === name) || [];
}

function getRawNodeText(node: ASTNode | undefined): string {
  if (!node || node.value === undefined) {
    return '';
  }
  if (node.name === 'EOF') {
    return '';
  }
  return node.value;
}

function reconstructExpressionText(node: ASTNode | undefined): string {
    if (!node) return '';
    if (node.value !== undefined) return node.value;
    if (node.children) {
        return node.children.map(reconstructExpressionText).join(' ');
    }
    return '';
}


function formatLeadingComments(comments: CommentInfo[] | undefined, indentStr: string, context: FormattingContext): string {
  let formatted = '';
  if (comments) {
    comments.forEach(comment => {
      if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
        formatted += indentStr + comment.text + '\n';
        context.processedCommentIndices.add(comment.originalTokenIndex);
      }
    });
  }
  return formatted;
}

function formatTrailingComments(node: ASTNode | undefined, context: FormattingContext): string {
    if (!node || !node.trailingComments) {
        return '';
    }
    let formatted = '';
    node.trailingComments.forEach(comment => {
        if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
            formatted += ' ' + comment.text;
            context.processedCommentIndices.add(comment.originalTokenIndex);
        }
    });
    return formatted;
}


function formatASTNode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
  if (!node || node.name === 'EOF') {
      return '';
  }

  const baseIndent = '    '.repeat(indentLevel);
  let result = '';

  result += formatLeadingComments(node.leadingComments, baseIndent, context);

  let nodeContent = '';
  switch (node.name) {
    case 'source_text':
        nodeContent = (node.children || []).map(child => formatASTNode(child, config, indentLevel, context)).join('');
        break;
    case 'module_declaration':
        nodeContent = formatModuleDeclaration(node, config, indentLevel, context);
        break;
    case 'module_item':
        const actualItem = node.children?.[0];
        if (actualItem) {
            nodeContent = formatASTNode(actualItem, config, indentLevel, context);
        }
        break;
    case 'always_construct':
        nodeContent = formatAlwaysConstruct(node, config, indentLevel, context);
        break;
    default:
        break;
  }
  result += nodeContent;
  result += formatTrailingComments(node, context);
  
  return result;
}

function formatModuleDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
  const indent = '    '.repeat(indentLevel);
  let content = indent + getRawNodeText(findChild(node, 'MODULE'));
  
  content += ' ' + getRawNodeText(findChild(node, 'IDENTIFIER'));
  content += formatTrailingComments(findChild(node, 'IDENTIFIER'), context);

  const paramList = findChild(node, 'parameter_port_list');
  if (paramList) {
      content += ' ' + formatParameterPortList(paramList, config, indentLevel, context);
  }

  const portList = findChild(node, 'port_list');
  if (portList) {
      content += '\n' + indent + formatPortList(portList, config, indentLevel, context);
  }

  content += getRawNodeText(findChild(node, 'SEMI')) + '\n';
  
  const moduleItems = findAllChildren(node, 'module_item');
  if (moduleItems.length > 0) {
      content += '\n';
      content += moduleItems.map(item => formatASTNode(item, config, indentLevel + 1, context)).join('');
  }

  content += '\n' + indent + getRawNodeText(findChild(node, 'ENDMODULE'));
  content += formatTrailingComments(findChild(node, 'ENDMODULE'), context);
  
  return content;
}

function formatParameterPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = '    '.repeat(indentLevel);
    let content = getRawNodeText(findChild(node, 'HASH')) + getRawNodeText(findChild(node, 'LPAREN')) + '\n';

    const assignments = findAllChildren(node, 'param_assignment');
    
    assignments.forEach((p, index) => {
        const lineIndent = '    '.repeat(indentLevel + 1);
        let line = '';
        
        line += formatLeadingComments(p.leadingComments, lineIndent, context);
        line += lineIndent;

        const keyword = getRawNodeText(findChild(p, 'PARAMETER'));
        const identifier = getRawNodeText(findChild(p, 'IDENTIFIER'));
        const valueExpr = findChild(p, 'constant_expression');
        const value = valueExpr ? reconstructExpressionText(valueExpr) : '';

        line += keyword;
        let currentPos = lineIndent.length + keyword.length;

        let spaces = Math.max(1, config.get<number>('param_num2', 25) - currentPos);
        line += ' '.repeat(spaces) + identifier;
        currentPos += spaces + identifier.length;
        
        spaces = Math.max(1, config.get<number>('param_num3', 50) - currentPos);
        line += ' '.repeat(spaces) + '= ' + value;
        
        if (index < assignments.length - 1) {
            line += ',';
        }

        line += formatTrailingComments(p, context);
        
        content += line + '\n';
    });

    content += indent + getRawNodeText(findChild(node, 'RPAREN'));
    return content;
}

function formatPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = '    '.repeat(indentLevel);
    let content = getRawNodeText(findChild(node, 'LPAREN')) + '\n';
    
    const portDeclarations = findAllChildren(node, 'port_declaration');
    
    portDeclarations.forEach((port, index) => {
        const lineIndent = '    '.repeat(indentLevel + 1);
        let line = '';

        line += formatLeadingComments(port.leadingComments, lineIndent, context);
        
        const actualDecl = port.children?.[0];
        if (actualDecl) {
            line += formatLeadingComments(actualDecl.leadingComments, lineIndent, context);
            line += formatPortDeclaration(actualDecl, config, indentLevel + 1, context);

            if (index < portDeclarations.length - 1) {
                line += ',';
            }

            line += formatTrailingComments(actualDecl, context);
            line += formatTrailingComments(port, context);
        }
        content += line + '\n';
    });

    content += indent + getRawNodeText(findChild(node, 'RPAREN'));
    return content;
}

function formatPortDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = '    '.repeat(indentLevel);
    let line = indentStr;
    let currentAbsoluteColumn = indentStr.length;

    let typePart = '';
    if (node.name === 'input_declaration') typePart = 'input';
    else if (node.name === 'output_declaration') typePart = 'output';
    else if (node.name === 'inout_declaration') typePart = 'inout';
    
    const regKeywordPart = getRawNodeText(findChild(node, 'REG')) || getRawNodeText(findChild(node, 'WIRE')) || '';
    const signedUnsignedPart = getRawNodeText(findChild(node, 'SIGNED')) || '';
    const rangeNode = findChild(node, 'range_expression');
    const widthPart = rangeNode ? formatBitWidthDeclaration(rangeNode, config) : '';
    const signalPart = getRawNodeText(findChild(node, 'IDENTIFIER'));

    line += typePart;
    currentAbsoluteColumn = line.length;

    if (regKeywordPart) {
      line += ' ' + regKeywordPart;
      currentAbsoluteColumn = line.length;
    }
    
    let spaces = Math.max(1, config.get<number>('port_num2', 16) - currentAbsoluteColumn);
    line += ' '.repeat(spaces);
    if (signedUnsignedPart) {
        line += signedUnsignedPart;
    }
    currentAbsoluteColumn = line.length;

    spaces = Math.max(1, config.get<number>('port_num3', 25) - currentAbsoluteColumn);
    line += ' '.repeat(spaces);
    if (widthPart) {
        line += widthPart;
    }
    currentAbsoluteColumn = line.length;

    spaces = Math.max(1, config.get<number>('port_num4', 50) - currentAbsoluteColumn);
    line += ' '.repeat(spaces) + signalPart;
    
    return line;
}

function formatBitWidthDeclaration(rangeNode: ASTNode, config: vscode.WorkspaceConfiguration): string {
    const upbound = config.get('upbound', 2);
    const lowbound = config.get('lowbound', 2);

    const expressions = findAllChildren(rangeNode, 'expression');
    if (expressions.length === 0) return "[]";

    const msb = reconstructExpressionText(expressions[0]);
    const lsb = expressions.length > 1 ? reconstructExpressionText(expressions[1]) : '';

    const alignedMsb = msb.padStart(Math.max(upbound, msb.length), ' ');
    const alignedLsb = lsb.padEnd(Math.max(lowbound, lsb.length), ' ');

    if (lsb) {
        return `[${alignedMsb}:${alignedLsb}]`;
    }
    return `[${alignedMsb}]`;
}


// =========================================================================
// [ULTIMATE REWRITE - FINAL VERSION] Statement Formatting Logic
// =========================================================================

/**
 * Formats an `always_construct` node.
 */
function formatAlwaysConstruct(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = '    '.repeat(indentLevel);

    const eventControl = findChild(node, 'event_control');
    const eventExpression = eventControl ? findChild(eventControl, 'event_expression') : undefined;
    const sensitivityList = eventExpression ? reconstructExpressionText(eventExpression) : '';
    
    let content = indentStr + 'always @(' + sensitivityList + ')\n';

    const statement = findChild(node, 'statement_or_null');
    if (statement) {
        content += formatStatementOrNullNode(statement, config, indentLevel, context);
    }
    return content;
}

/**
 * [REWRITTEN] Formats a `statement_or_null` node.
 * This is a WRAPPER node. Its only job is to unwrap its child and pass it to the correct formatter.
 */
function formatStatementOrNullNode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = '    '.repeat(indentLevel);
    let content = '';
    content += formatLeadingComments(node.leadingComments, indentStr, context);
    
    const statementNode = node.children?.[0]; // This is the actual `statement` node inside
    
    if (statementNode) {
        if (statementNode.name === 'SEMI') {
            content += indentStr + ';';
        } else {
            // Pass the actual statement to the main statement formatter
            content += formatStatementNode(statementNode, config, indentLevel, context);
        }
    }
    
    content += formatTrailingComments(node, context);
    return content;
}

/**
 * [REWRITTEN] Formats a `statement` node.
 * This is the CORE formatter that handles the actual logic (begin, if, assignment).
 */
function formatStatementNode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = '    '.repeat(indentLevel);
    const firstChild = node.children?.[0]; 
    if (!firstChild) return '';

    let content = '';
    content += formatLeadingComments(node.leadingComments, indentStr, context);

    switch (firstChild.name) {
        case 'BEGIN': {
            content += indentStr + 'begin\n';
            // Find all direct `statement` children within the begin-end block.
            const statementsInBlock = findAllChildren(node, 'statement');
            
            // [CRITICAL FIX] Recursively call the CORRECT formatter for each statement.
            content += statementsInBlock.map(s => 
                formatStatementNode(s, config, indentLevel + 1, context)
            ).join('\n');

            content += '\n' + indentStr + 'end';
            content += formatTrailingComments(findChild(node, 'END'), context);
            break;
        }
        case 'IF': {
            const ifExpr = findChild(node, 'expression');
            content += indentStr + 'if (' + reconstructExpressionText(ifExpr) + ')\n';
            
            const statementOrNullNodes = findAllChildren(node, 'statement_or_null');
            const thenClause = statementOrNullNodes[0];
            const elseClause = findChild(node, 'ELSE') ? statementOrNullNodes[1] : undefined;
            
            if (thenClause) {
                // `then` clauses are `statement_or_null`, so call the correct wrapper formatter.
                content += formatStatementOrNullNode(thenClause, config, indentLevel + 1, context);
            }
            
            if (elseClause) {
                content += '\n' + indentStr + 'else\n';
                // `else` clauses are also `statement_or_null`.
                content += formatStatementOrNullNode(elseClause, config, indentLevel + 1, context);
            }
            break;
        }
        case 'assignment_statement': {
            const assignNode = firstChild;
            const lvalue = reconstructExpressionText(findChild(assignNode, 'variable_lvalue'));
            const operator = getRawNodeText(findChild(assignNode, 'LE_OP')) || getRawNodeText(findChild(assignNode, 'ASSIGN_OP'));
            const expression = reconstructExpressionText(findChild(assignNode, 'expression'));
            
            content += indentStr + lvalue + ' ' + operator + ' ' + expression + ';';
            // Trailing comment is on the parent 'statement' (which is 'node' here).
            content += formatTrailingComments(node, context);
            break;
        }
        default:
            // Fallback for any other simple statement type.
            content += indentStr + reconstructExpressionText(node) + ';';
            content += formatTrailingComments(node, context);
            break;
    }
    
    return content;
}


// =========================================================================
// 旧的基于正则表达式的对齐函数 (保持不变)
// =========================================================================

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
        return alignPortDeclarationRegex(line, config);
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

function alignPortDeclarationRegex(line: string, config: vscode.WorkspaceConfiguration): string {
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

  const alignedWidth = width ? alignBitWidthDeclarationRegex(width, config) : '';

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

  const alignedWidth = width ? alignBitWidthDeclarationRegex(width, config) : '';

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

function alignBitWidthDeclarationRegex(bitwidthString: string, config: vscode.WorkspaceConfiguration): string {
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

  const alignedWidth1 = width1 ? alignBitWidthDeclarationRegex(width1, config) : '';
  const alignedWidth2 = width2 ? alignBitWidthDeclarationRegex(width2, config) : '';

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
