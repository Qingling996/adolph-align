import * as vscode from 'vscode';
import * as fs from 'fs';

// =========================================================================
// 接口定义 (保持不变)
// =========================================================================
interface CommentInfo {
  text: string;
  type: 'line' | 'block' | 'comment';
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
    originalText: string;
    config: vscode.WorkspaceConfiguration;
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
            return alignFromAST(ast, config, text);
        } catch (error: any) {
            console.error(`[Aligner] Error processing AST file: ${error.message}\n${error.stack}`);
            vscode.window.showErrorMessage(`AST文件处理失败: ${error.message}. 降级到正则表达式模式。`);
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

const indentChar = '    ';

function alignFromAST(astRootNode: ASTNode, config: vscode.WorkspaceConfiguration, originalText: string): string {
    const context: FormattingContext = {
        processedCommentIndices: new Set<number>(),
        originalText: originalText,
        config: config
    };
    return formatASTNode(astRootNode, config, 0, context).trim() + '\n';
}

function findChild(node: ASTNode | undefined, name: string): ASTNode | undefined {
    if (!node || !node.children) return undefined;
    return node.children.find(child => child.name === name);
}

function findAllChildren(node: ASTNode, name: string): ASTNode[] {
    if (!node || !node.children) return [];
    return node.children.filter(child => child.name === name);
}

function getRawNodeText(node: ASTNode | undefined): string {
  if (!node || node.value === undefined) return '';
  return node.value;
}

function extractOriginalText(node: ASTNode, fullText: string): string {
    if (!node.start || !node.end) {
        return '';
    }
    const lines = fullText.split('\n');
    const startLine = node.start.line - 1;
    const endLine = node.end.line - 1;
    const startCol = node.start.column;
    const endCol = node.end.column;

    if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
        return '';
    }

    if (startLine === endLine) {
        return lines[startLine].substring(startCol, endCol);
    }

    let extracted = '';
    extracted += lines[startLine].substring(startCol);
    for (let i = startLine + 1; i < endLine; i++) {
        extracted += '\n' + lines[i];
    }
    extracted += '\n' + lines[endLine].substring(0, endCol);

    return extracted.trim();
}

function reconstructExpressionText(node: ASTNode | undefined, context: FormattingContext): string {
    if (!node) return '';

    if (node.name === 'range_expression') {
        const children = node.children || [];
        if (
            children.length === 5 &&
            children[0].name === 'LBRACK' &&
            children[2].name === 'COLON' &&
            children[4].name === 'RBRACK'
        ) {
             const bitwidthString = `[${reconstructExpressionText(children[1], context)}:${reconstructExpressionText(children[3], context)}]`;
             return alignBitWidthDeclarationRegex(bitwidthString, context.config);
        }
    }
    
    if (node.value !== undefined) return node.value;

    if (node.children && node.children.length > 0) {
        let result = '';
        const noSpaceAfter = new Set(['[', '{', '.', '(', '`']);
        const noSpaceBefore = new Set(['[', ']', '{', '}', '.', '(', ')', ',', ';', ':']);
        
        for (const child of node.children) {
            const currentToken = reconstructExpressionText(child, context);
            if (!currentToken) continue;

            if (result.length > 0) {
                const firstCharOfCurrent = currentToken.charAt(0);
                const lastCharOfResult = result.charAt(result.length - 1);
                
                if (
                    !noSpaceAfter.has(lastCharOfResult) &&
                    !noSpaceBefore.has(firstCharOfCurrent)
                ) {
                    result += ' ';
                }
            }
            result += currentToken;
        }
        return result;
    }
    return '';
}

function formatLeadingComments(comments: CommentInfo[] | undefined, indentStr: string, context: FormattingContext): string {
  if (!comments) return '';
  let formatted = '';
  comments.forEach(comment => {
    if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
      const commentLines = comment.text.split('\n');
      formatted += commentLines.map(l => indentStr + l).join('\n') + '\n';
      context.processedCommentIndices.add(comment.originalTokenIndex);
    }
  });
  return formatted;
}

function formatTrailingComments(comments: CommentInfo[] | undefined, context: FormattingContext): string {
    if (!comments) return '';
    let formatted: string[] = [];
    comments.forEach(comment => {
        if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
            let text = comment.text.trim();
            if (text.startsWith('/*')) {
                text = '// ' + text.slice(2, -2).trim();
            } else if (!text.startsWith('//')) {
                 text = '// ' + text;
            }
            formatted.push(text);
            context.processedCommentIndices.add(comment.originalTokenIndex);
        }
    });
    return formatted.join(' ');
}

function findDeepTrailingComments(node: ASTNode): CommentInfo[] {
    let comments: CommentInfo[] = [];
    if (node.trailingComments) {
        comments.push(...node.trailingComments);
    }
    if (node.children) {
        for (let i = node.children.length - 1; i >= 0; i--) {
            comments.push(...findDeepTrailingComments(node.children[i]));
        }
    }
    return comments;
}

// =========================================================================
// PURE AST-DRIVEN FORMATTER (调度器)
// =========================================================================
function formatASTNode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    if (!node || node.name === 'EOF') return '';

    const baseIndent = indentChar.repeat(indentLevel);
    
    switch (node.name) {
        case 'source_text':
            let result = formatLeadingComments(node.leadingComments, '', context);
            result += (node.children || []).map(child => formatASTNode(child, config, indentLevel, context)).join('');
            return result;

        case 'module_declaration':
            return formatModuleDeclaration(node, config, indentLevel, context);

        case 'module_item': {
            const firstChild = node.children?.[0];
            if (!firstChild) return '';

            let itemContent = '';
            
            let decl;
            if (firstChild.name === 'signals_declaration') {
                decl = firstChild.children?.[0];
            }
            
            if (decl && (decl.name === 'parameter_declaration' || decl.name === 'localparam_declaration')) {
                const leadingComments = formatLeadingComments(decl.leadingComments, baseIndent, context);
                let codeLine = formatLocalParameterDeclaration(decl, config, indentLevel, context);
                const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
                const alignColumn = config.get<number>('localparam_num4', 80);
                const finalPart = ';' + (trailingComment ? ' ' + trailingComment : '');
                const spaces = Math.max(1, alignColumn - codeLine.length);
                codeLine += ' '.repeat(spaces) + finalPart;
                itemContent = leadingComments + codeLine + '\n';
            } else if (firstChild.name === 'always_construct') {
                const leadingComments = formatLeadingComments(firstChild.leadingComments, baseIndent, context);
                itemContent = leadingComments + formatAlwaysConstruct(firstChild, config, indentLevel, context);
            } else if (firstChild.name === 'signals_declaration') { 
                const signalDecl = firstChild.children?.[0];
                const leadingComments = formatLeadingComments(signalDecl?.leadingComments, baseIndent, context);
                let codeLine = formatSignalsDeclaration(firstChild, config, indentLevel, context);
                const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
                const alignColumn = config.get<number>('signal_num5', 80);
                const finalPart = ';' + (trailingComment ? ' ' + trailingComment : '');
                const spaces = Math.max(1, alignColumn - codeLine.length);
                codeLine += ' '.repeat(spaces) + finalPart;
                itemContent = leadingComments + codeLine + '\n';
            } else if (firstChild.name === 'continuous_assign') {
                const leadingComments = formatLeadingComments(firstChild.leadingComments, baseIndent, context);
                let codeLine = formatContinuousAssign(firstChild, config, indentLevel, context);
                const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
                const alignColumn = config.get<number>('assign_num4', 80);
                const finalPart = ';' + (trailingComment ? ' ' + trailingComment : '');
                const spaces = Math.max(1, alignColumn - codeLine.length);
                codeLine += ' '.repeat(spaces) + finalPart;
                itemContent = leadingComments + codeLine + '\n';
            } else if (firstChild.name === 'module_instantiation') { 
                const leadingComments = formatLeadingComments(firstChild.leadingComments, baseIndent, context);
                let codeBlock = formatModuleInstantiation(firstChild, config, indentLevel, context);
                const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
                if (trailingComment) {
                    codeBlock = codeBlock.trimEnd() + ' ' + trailingComment + '\n';
                }
                itemContent = leadingComments + codeBlock;
            }
            return itemContent;
        }

        default:
            return (node.children || []).map(child => formatASTNode(child, config, indentLevel, context)).join('');
    }
}

// =========================================================================
// DEDICATED AST-BASED FORMATTERS
// =========================================================================

function formatModuleDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
  const indent = indentChar.repeat(indentLevel);
  let content = formatLeadingComments(node.leadingComments, indent, context);
  content += indent + 'module ' + getRawNodeText(findChild(node, 'IDENTIFIER'));
  
  const paramList = findChild(node, 'parameter_port_list');
  if (paramList) content += ' ' + formatParameterPortList(paramList, config, indentLevel, context);
  
  const portList = findChild(node, 'port_list');
  if (portList) content += '\n' + formatPortList(portList, config, indentLevel, context);
  
  content += ';\n';
  
  const moduleItems = findAllChildren(node, 'module_item');
  if (moduleItems.length > 0) {
      content += '\n' + moduleItems.map(item => formatASTNode(item, config, indentLevel + 1, context)).join('');
  }
  
  content += '\n' + indent + 'endmodule';
  const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
  if (trailingComment) {
      content += ' ' + trailingComment;
  }
  return content;
}

function formatParameterPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const paramIndentStr = indentChar.repeat(indentLevel + 1);
    const param_num2 = config.get<number>('param_num2', 25);
    const param_num3 = config.get<number>('param_num3', 50);
    const param_num4 = config.get<number>('param_num4', 80);

    interface ParameterLineInfo {
        node: ASTNode;
        blockComments: CommentInfo[];
        lineComment: string;
    }

    const assignments = findAllChildren(node, 'param_assignment');
    if (assignments.length === 0) return '#()';

    const lineInfos: ParameterLineInfo[] = [];
    for (const p of assignments) {
        const info: ParameterLineInfo = { node: p, blockComments: [], lineComment: '' };
        if (p.leadingComments) {
            info.blockComments.push(...p.leadingComments.filter(c => c.text.startsWith('/*')));
        }
        info.lineComment = formatTrailingComments(findDeepTrailingComments(p), context);
        lineInfos.push(info);
    }

    for(let i = 0; i < lineInfos.length -1; i++) {
        const nextNode = lineInfos[i+1].node;
        if (nextNode.leadingComments) {
            const leadingLineComments = nextNode.leadingComments.filter(c => c.text.startsWith('//'));
            if (leadingLineComments.length > 0) {
                const commentText = formatTrailingComments(leadingLineComments, context);
                lineInfos[i].lineComment = [lineInfos[i].lineComment, commentText].filter(Boolean).join(' ');
            }
        }
    }

    const resultLines: string[] = [];
    for (let i = 0; i < lineInfos.length; i++) {
        const info = lineInfos[i];
        
        resultLines.push(formatLeadingComments(info.blockComments, paramIndentStr, context).trimEnd());

        const keyword = getRawNodeText(findChild(info.node, 'PARAMETER'));
        const identifier = getRawNodeText(findChild(info.node, 'IDENTIFIER'));
        const value = reconstructExpressionText(findChild(info.node, 'constant_expression'), context);

        let currentLine = paramIndentStr + keyword;
        currentLine += ' '.repeat(Math.max(1, param_num2 - currentLine.length));
        currentLine += identifier;
        currentLine += ' '.repeat(Math.max(1, param_num3 - currentLine.length));
        currentLine += '= ' + value;

        const isLast = (i === lineInfos.length - 1);
        const separator = isLast ? '' : ',';
        const finalPart = separator + (info.lineComment ? ' ' + info.lineComment : '');

        if (finalPart.trim()) {
            const spacesNeeded = Math.max(1, param_num4 - currentLine.length);
            currentLine += ' '.repeat(spacesNeeded) + finalPart;
        } else {
            currentLine += separator;
        }
        resultLines.push(currentLine);
    }
    
    return `#(\n${resultLines.filter(Boolean).join('\n')}\n${indent})`;
}

function formatPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const portIndent = indentChar.repeat(indentLevel + 1);
    const commentAlignColumn = config.get<number>('port_num5', 80);

    interface PortLineInfo {
        node: ASTNode;
        blockComments: CommentInfo[];
        lineComment: string;
    }

    const portDecls = findAllChildren(node, 'port_declaration');
    if (portDecls.length === 0) {
        return `${indent}()`;
    }

    const lineInfos: PortLineInfo[] = [];
    for (const decl of portDecls) {
        const info: PortLineInfo = { node: decl, blockComments: [], lineComment: '' };
        const actualDecl = decl.children![0];

        if (actualDecl.leadingComments) {
            info.blockComments.push(...actualDecl.leadingComments.filter(c => c.text.startsWith('/*')));
        }
        info.lineComment = formatTrailingComments(findDeepTrailingComments(actualDecl), context);
        lineInfos.push(info);
    }

    for (let i = 0; i < lineInfos.length - 1; i++) {
        const nextNode = lineInfos[i+1].node.children?.[0];
        if (nextNode && nextNode.leadingComments) {
            const leadingLineComments = nextNode.leadingComments.filter(c => c.text.startsWith('//'));
            if(leadingLineComments.length > 0) {
                 const commentText = formatTrailingComments(leadingLineComments, context);
                 lineInfos[i].lineComment = [lineInfos[i].lineComment, commentText].filter(Boolean).join(' ');
            }
        }
    }
    
    const resultLines: string[] = [];
    for (let i = 0; i < lineInfos.length; i++) {
        const info = lineInfos[i];
        
        resultLines.push(formatLeadingComments(info.blockComments, portIndent, context).trimEnd());

        let codeLine = formatPortDeclaration(info.node, config, indentLevel + 1, context);
        
        const isLast = (i === lineInfos.length - 1);
        const separator = isLast ? '' : ',';
        
        const finalPart = separator + (info.lineComment ? " " + info.lineComment : "");
        if (finalPart.trim()) {
            const spacesNeeded = Math.max(1, commentAlignColumn - codeLine.length);
            codeLine += ' '.repeat(spacesNeeded) + finalPart;
        } else {
            codeLine += separator;
        }
        resultLines.push(codeLine);
    }

    return `${indent}(\n${resultLines.filter(Boolean).join('\n')}\n${indent})`;
}

function formatPortDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const declaration = node.children?.[0];
    if (!declaration) return indentStr;
    
    let typePart = '';
    if (declaration.name === 'input_declaration') typePart = 'input';
    else if (declaration.name === 'output_declaration') typePart = 'output';
    else if (declaration.name === 'inout_declaration') typePart = 'inout';

    const regKeywordPart = getRawNodeText(findChild(declaration, 'REG')) || '';
    const signedUnsignedPart = getRawNodeText(findChild(declaration, 'SIGNED')) || '';
    const widthPart = reconstructExpressionText(findChild(declaration, 'range_expression'), context) || '';
    const signalPart = getRawNodeText(findChild(declaration, 'IDENTIFIER'));
    
    const port_num2 = config.get<number>('port_num2', 16);
    const port_num3 = config.get<number>('port_num3', 25);
    const port_num4 = config.get<number>('port_num4', 50);

    const typeAndReg = [typePart, regKeywordPart].filter(Boolean).join(' ');
    
    let currentLine = indentStr + typeAndReg;
    currentLine += ' '.repeat(Math.max(1, port_num2 - currentLine.length));
    currentLine += signedUnsignedPart;
    currentLine += ' '.repeat(Math.max(1, port_num3 - currentLine.length));
    currentLine += widthPart;
    currentLine += ' '.repeat(Math.max(1, port_num4 - currentLine.length));
    currentLine += signalPart;
    
    return currentLine;
}

function formatLocalParameterDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const localparam_num2 = config.get<number>('localparam_num2', 25);
    const localparam_num3 = config.get<number>('localparam_num3', 50);

    const keyword = getRawNodeText(findChild(node, 'PARAMETER')) || getRawNodeText(findChild(node, 'LOCALPARAM')) || 'parameter';
    const identifier = getRawNodeText(findChild(findChild(node, 'list_of_identifiers'), 'IDENTIFIER'));
    const value = reconstructExpressionText(findChild(node, 'constant_expression'), context);

    let currentLine = indentStr + keyword;
    currentLine += ' '.repeat(Math.max(1, localparam_num2 - currentLine.length));
    currentLine += identifier;
    currentLine += ' '.repeat(Math.max(1, localparam_num3 - currentLine.length));
    currentLine += '= ' + value;

    return currentLine.trimEnd();
}

function formatSignalsDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const decl = node.children?.[0];
    if (!decl) return indentStr;

    let type = '';
    if (decl.name === 'reg_declaration') type = 'reg';
    else if (decl.name === 'wire_declaration') type = 'wire';
    else if (decl.name === 'integer_declaration') type = 'integer';
    else if (decl.name === 'real_declaration') type = 'real';
    
    const signed = getRawNodeText(findChild(decl, 'SIGNED')) || '';
    const range = reconstructExpressionText(findChild(decl, 'range_expression'), context) || '';
    const identifier = getRawNodeText(findChild(findChild(decl, 'list_of_identifiers'), 'IDENTIFIER'));
    
    const signal_num2 = config.get<number>('signal_num2', 16);
    const signal_num3 = config.get<number>('signal_num3', 25);
    const signal_num4 = config.get<number>('signal_num4', 50);
    
    let currentLine = indentStr + type;
    currentLine += ' '.repeat(Math.max(1, signal_num2 - currentLine.length));
    currentLine += signed;
    currentLine += ' '.repeat(Math.max(1, signal_num3 - currentLine.length));
    currentLine += range;
    currentLine += ' '.repeat(Math.max(1, signal_num4 - currentLine.length));
    currentLine += identifier;
    
    return currentLine.trimEnd();
}

function formatContinuousAssign(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const assign_num2 = config.get<number>('assign_num2', 12);
    const assign_num3 = config.get<number>('assign_num3', 30);
    
    const lvalueNode = findChild(node, 'variable_lvalue') || findChild(node, 'net_lvalue');
    const expressionNode = findChild(node, 'expression');

    if (!lvalueNode || !expressionNode) {
        return indentStr + 'assign ; // Error: Could not parse assignment structure from AST.';
    }

    const lvalue = reconstructExpressionText(lvalueNode, context);
    const expression = reconstructExpressionText(expressionNode, context);

    let currentLine = indentStr + 'assign';
    currentLine += ' '.repeat(Math.max(1, assign_num2 - currentLine.length));
    currentLine += lvalue;
    currentLine += ' '.repeat(Math.max(1, assign_num3 - currentLine.length));
    currentLine += '= ' + expression;
    
    return currentLine;
}

function formatModuleInstantiation(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);

    const moduleName = getRawNodeText(findChild(node, 'IDENTIFIER'));
    let content = baseIndent + moduleName;

    const paramAssignmentsNode = findChild(node, 'parameter_value_assignment');
    if (paramAssignmentsNode) {
        const paramList = findChild(paramAssignmentsNode, 'list_of_param_assignments');
        if (paramList && paramList.children && paramList.children.length > 0) {
            content += ' #(\n';
            const paramNodes = paramList.children.filter(c => c.name === 'named_parameter_assignment');
            content += formatNamedAssignments(paramNodes, config, indentLevel + 1, context, 'inst');
            content += '\n' + baseIndent + ')';
        } else {
            content += ' #()';
        }
    }

    const moduleInstanceNode = findChild(node, 'module_instance');
    if (moduleInstanceNode) {
        const instanceName = getRawNodeText(findChild(findChild(moduleInstanceNode, 'name_of_instance'), 'IDENTIFIER'));
        content += ' ' + instanceName;

        const portConnectionsNode = findChild(moduleInstanceNode, 'list_of_port_connections');
        if (portConnectionsNode && portConnectionsNode.children && portConnectionsNode.children.length > 0) {
            content += ' (\n';
            const portNodes = portConnectionsNode.children.filter(c => c.name === 'named_port_connection');
            content += formatNamedAssignments(portNodes, config, indentLevel + 1, context, 'inst');
            content += '\n' + baseIndent + ')';
        } else {
            content += ' ()';
        }
    }

    content += ';\n';
    return content;
}

// **MODIFIED**: Adopted advanced comment handling from port lists.
function formatNamedAssignments(
    nodes: ASTNode[], 
    config: vscode.WorkspaceConfiguration, 
    indentLevel: number, 
    context: FormattingContext,
    configPrefix: 'inst'
): string {
    const indentStr = indentChar.repeat(indentLevel);
    const col2 = config.get<number>(`${configPrefix}_num2`, 40);
    const col3 = config.get<number>(`${configPrefix}_num3`, 80);

    interface LineInfo {
        node: ASTNode;
        namePart: string;
        valueStr: string;
        blockCommentText: string;
        trailingCommentText: string;
    }

    // Step 1: Data Collection
    const lineInfos: LineInfo[] = [];
    for (const node of nodes) {
        const namePart = '.' + getRawNodeText(findChild(node, 'IDENTIFIER'));
        const valueStr = reconstructExpressionText(findChild(node, 'expression'), context);
        
        // Separate block comments from line comments
        const blockCommentText = formatLeadingComments(node.leadingComments?.filter(c => c.text.startsWith('/*')), indentStr, context);
        const trailingCommentText = formatTrailingComments(findDeepTrailingComments(node), context);

        lineInfos.push({ node, namePart, valueStr, blockCommentText, trailingCommentText });
    }

    // Step 2: Comment Redistribution
    for (let i = 0; i < lineInfos.length - 1; i++) {
        const nextNode = lineInfos[i + 1].node;
        if (nextNode.leadingComments) {
            const lineComments = nextNode.leadingComments.filter(c => c.text.startsWith('//'));
            if (lineComments.length > 0) {
                const commentText = formatTrailingComments(lineComments, context);
                lineInfos[i].trailingCommentText = [lineInfos[i].trailingCommentText, commentText].filter(Boolean).join(' ');
            }
        }
    }
    
    // Step 3: Rendering
    const resultLines: string[] = [];
    for (let i = 0; i < lineInfos.length; i++) {
        const info = lineInfos[i];
        
        // Add any block comments first
        if (info.blockCommentText) {
            resultLines.push(info.blockCommentText.trimEnd());
        }
        
        // Build the main code line
        let currentLine = indentStr + info.namePart;
        currentLine += ' '.repeat(Math.max(1, col2 - currentLine.length));
        currentLine += '(' + info.valueStr;
        
        // Align the closing parenthesis
        const spacesForParen = Math.max(1, col3 - 1 - currentLine.length);
        currentLine += ' '.repeat(spacesForParen) + ')';

        // Add separator (comma)
        const isLast = (i === lineInfos.length - 1);
        if (!isLast) {
            currentLine += ',';
        }

        // Add trailing comment (now including redistributed comments)
        if (info.trailingCommentText) {
            currentLine += ' ' + info.trailingCommentText;
        }

        resultLines.push(currentLine);
    }
    
    return resultLines.join('\n');
}

function formatAlwaysConstruct(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);
    
    const sensitivityList = reconstructExpressionText(findChild(node, 'event_control'), context);
    let content = baseIndent + 'always ' + sensitivityList + ' begin\n';

    const body = findChild(node, 'statement_or_null');
    if (body) {
        let unwrappedBody = body;
        while (unwrappedBody.children?.length === 1 && ['statement_or_null', 'statement'].includes(unwrappedBody.name)) {
            unwrappedBody = unwrappedBody.children[0];
        }

        const statementsInBlock = findAllChildren(unwrappedBody, 'statement');
        if (statementsInBlock.length > 0) {
            const statements = statementsInBlock.map(s => formatStatement(s, config, indentLevel + 1, context));
            content += statements.join('\n');
        }
    }

    content += '\n' + baseIndent + 'end\n';
    return content;
}

interface StatementStyle { isKnrStyle?: boolean; isChainedIf?: boolean; }

function formatStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    let unwrappedItem = node;
    while (unwrappedItem.children?.length === 1 && ['statement_or_null', 'statement'].includes(unwrappedItem.name)) {
        unwrappedItem = unwrappedItem.children[0];
    }

    const leadingComments = formatLeadingComments(unwrappedItem.leadingComments, indentChar.repeat(indentLevel), context);
    let result = '';
    
    if (findChild(unwrappedItem, 'IF')) {
        result = formatIfStatement(unwrappedItem, config, indentLevel, context, style);
    } else if (findChild(unwrappedItem, 'BEGIN')) {
        result = formatBeginEnd(unwrappedItem, config, indentLevel, context, style);
    } else if (findChild(unwrappedItem, 'FOR')) {
        result = formatForStatement(unwrappedItem, config, indentLevel, context, style);
    } else {
        const itemIndent = indentChar.repeat(indentLevel);
        let coreContent = '';

        if (unwrappedItem.name === 'assignment_statement') {
            const lvalueNode = findChild(unwrappedItem, 'variable_lvalue');
            const expressionNode = findChild(unwrappedItem, 'expression');

            const lvalue = lvalueNode ? reconstructExpressionText(lvalueNode, context) : '';
            const operator = getRawNodeText(findChild(unwrappedItem, 'LE_OP')) ? '<=' : '=';
            const expression = expressionNode ? reconstructExpressionText(expressionNode, context) : '';
            
            if (lvalue && expression) {
                coreContent = itemIndent + lvalue + ' ' + operator + ' ' + expression + ' ;';
            } else {
                coreContent = itemIndent + extractOriginalText(unwrappedItem, context.originalText);
                if (!coreContent.trim().endsWith(';')) coreContent += ';';
            }
        } else {
             let defaultContent = reconstructExpressionText(unwrappedItem, context);
             if (defaultContent.trim() && !defaultContent.trim().endsWith(';')) {
                defaultContent += ' ;';
             }
             coreContent = itemIndent + defaultContent;
        }
        result = coreContent;
    }
    
    const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
    if (trailingComment) {
      result += ' ' + trailingComment;
    }

    return leadingComments + result;
}

function formatBeginEnd(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    let content = (style.isKnrStyle ? '' : baseIndent) + 'begin';
    
    const statementsInBlock = findAllChildren(node, 'statement');
    if (statementsInBlock.length > 0) {
        content += '\n';
        const statements = statementsInBlock.map(s => formatStatement(s, config, indentLevel + 1, context));
        content += statements.join('\n');
        content += '\n' + baseIndent;
    }
    
    content += 'end';
    return content;
}

function formatIfStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const ifIndentStr = style.isChainedIf ? '' : baseIndent;
    
    const [thenClause, elseClauseCandidate] = findAllChildren(node, 'statement_or_null');

    if (!thenClause) {
        return ifIndentStr + extractOriginalText(node, context.originalText);
    }
    
    const thenContent = formatStatement(thenClause, config, indentLevel, context, { isKnrStyle: true });
    if (!thenContent.trim()) {
        return ifIndentStr + extractOriginalText(node, context.originalText);
    }

    let content = ifIndentStr + 'if (' + reconstructExpressionText(findChild(node, 'expression'), context) + ') ';
    content += thenContent;
    
    const elseToken = findChild(node, 'ELSE');
    
    if (elseToken && elseClauseCandidate) {
        content += '\n' + baseIndent + 'else';
        let elseUnwrapped = elseClauseCandidate;
        while (elseUnwrapped.children?.length === 1 && ['statement_or_null', 'statement'].includes(elseUnwrapped.name)) {
            elseUnwrapped = elseUnwrapped.children[0];
        }
        const isChainedIf = findChild(elseUnwrapped, 'IF');
        if (isChainedIf) {
            content += ' ' + formatIfStatement(elseUnwrapped, config, indentLevel, context, { isChainedIf: true });
        } else { 
            content += ' ' + formatStatement(elseClauseCandidate, config, indentLevel, context, { isKnrStyle: true });
        }
    }
    return content;
}

function formatForStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const baseIndent = indentChar.repeat(indentLevel);

    const initNode = findChild(node, 'variable_assignment');
    const conditionNode = findChild(node, 'expression');
    const stepNode = findAllChildren(node, 'variable_assignment')[1]; // The second assignment is the step
    const bodyNode = findChild(node, 'statement');

    if (!initNode || !conditionNode || !stepNode || !bodyNode) {
        return baseIndent + extractOriginalText(node, context.originalText) + (style.isKnrStyle ? "" : "\n");
    }

    const initPart = reconstructExpressionText(initNode, context);
    const condPart = reconstructExpressionText(conditionNode, context);
    const stepPart = reconstructExpressionText(stepNode, context);

    let content = baseIndent + `for (${initPart}; ${condPart}; ${stepPart}) `;
    
    // Pass isKnrStyle=true to format the body correctly (e.g., "begin" on the same line)
    content += formatStatement(bodyNode, config, indentLevel, context, { isKnrStyle: true });

    return content;
}


// =========================================================================
// REGEX-BASED FALLBACK MODE FUNCTIONS (Unchanged)
// =========================================================================
function alignVerilogCodeRegexOnly(text: string, config: vscode.WorkspaceConfiguration): string {
    const lines = text.split('\n');
    const alignedLines = lines.map(line => {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('/*') || trimmedLine.startsWith('//') || trimmedLine === '') return line;
      const isTwoDimArray = /^\s*(reg|wire)\s*(signed|unsigned)?\s*(\[[^\]]+\])\s*[^;,\s]+\s*(\[[^\]]+\])/.test(line);
      if (isTwoDimArray) return alignTwoDimArrayDeclaration(line, config);
      if (trimmedLine.startsWith('input') || trimmedLine.startsWith('output') || trimmedLine.startsWith('inout')) return alignPortDeclarationRegex(line, config);
      if (trimmedLine.startsWith('reg') || trimmedLine.startsWith('wire') || trimmedLine.startsWith('integer') || trimmedLine.startsWith('real')) return alignRegWireIntegerDeclaration(line, config);
      if (trimmedLine.startsWith('localparam') || trimmedLine.startsWith('parameter')) return alignParamDeclaration(line, config);
      if (trimmedLine.startsWith('assign')) return alignAssignDeclaration(line, config);
      if (trimmedLine.startsWith('.')) return alignInstanceSignal(line, config);
      return line;
    });
    return alignedLines.join('\n');
}
function alignPortDeclarationRegex(line: string, config: vscode.WorkspaceConfiguration): string {
    const port_num2 = config.get<number>('port_num2', 16);
    const port_num3 = config.get<number>('port_num3', 25);
    const port_num4 = config.get<number>('port_num4', 50);
    const port_num5 = config.get<number>('port_num5', 80);
    const regex = /^\s*(input\b|output\b|inout\b)\s*(reg|wire)?\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const type = match[1].trim();
    const regKeyword = (match[2] || '').trim();
    const signedUnsigned = (match[3] || '').trim();
    const width = (match[4] || '').trim();
    const signal = match[5].trim();
    const endSymbol = (match[6] || '').trim();
    const comment = (match[7] || '').trim();
    const alignedWidth = width ? alignBitWidthDeclarationRegex(width, config) : '';
    let coreLine = type;
    if (regKeyword) coreLine += ' ' + regKeyword;
    let currentLine = indent + coreLine;
    currentLine += ' '.repeat(Math.max(1, port_num2 - currentLine.length));
    currentLine += signedUnsigned;
    currentLine += ' '.repeat(Math.max(1, port_num3 - currentLine.length));
    currentLine += alignedWidth;
    currentLine += ' '.repeat(Math.max(1, port_num4 - currentLine.length));
    currentLine += signal;
    const endPart = endSymbol + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, port_num5 - currentLine.length);
        currentLine += ' '.repeat(spaces) + endPart;
    }
    return currentLine.trimEnd();
}
function alignRegWireIntegerDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
    const signal_num2 = config.get<number>('signal_num2', 16);
    const signal_num3 = config.get<number>('signal_num3', 25);
    const signal_num4 = config.get<number>('signal_num4', 50);
    const signal_num5 = config.get<number>('signal_num5', 80);
    const regex = /^\s*(reg\b|wire\b|integer\b|real\b)\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const type = match[1].trim();
    const signedUnsigned = (match[2] || '').trim();
    const width = (match[3] || '').trim();
    const signal = match[4].trim();
    const endSymbol = (match[5] || '').trim();
    const comment = (match[6] || '').trim();
    const alignedWidth = width ? alignBitWidthDeclarationRegex(width, config) : '';
    let currentLine = indent + type;
    currentLine += ' '.repeat(Math.max(1, signal_num2 - currentLine.length));
    currentLine += signedUnsigned;
    currentLine += ' '.repeat(Math.max(1, signal_num3 - currentLine.length));
    currentLine += alignedWidth;
    currentLine += ' '.repeat(Math.max(1, signal_num4 - currentLine.length));
    currentLine += signal;
    const endPart = (endSymbol || ';') + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, signal_num5 - currentLine.length);
        currentLine += ' '.repeat(spaces) + endPart;
    }
    return currentLine.trimEnd();
}
function alignParamDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
    const localparam_num2 = config.get<number>('localparam_num2', 25);
    const localparam_num3 = config.get<number>('localparam_num3', 50);
    const localparam_num4 = config.get<number>('localparam_num4', 80);
    const regex = /^\s*(localparam\b|parameter\b)\s+([^\s=]+)\s*=\s*([^;,\/]+)\s*([;,])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const type = match[1].trim();
    const signal = match[2].trim();
    const value = match[3].trim();
    const endSymbol = (match[4] || '').trim();
    const comment = (match[5] || '').trim();
    let currentLine = indent + type;
    currentLine += ' '.repeat(Math.max(1, localparam_num2 - currentLine.length));
    currentLine += signal;
    currentLine += ' '.repeat(Math.max(1, localparam_num3 - currentLine.length));
    currentLine += '= ' + value;
    const endPart = (endSymbol || ';') + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, localparam_num4 - currentLine.length);
        currentLine += ' '.repeat(spaces) + endPart;
    }
    return currentLine.trimEnd();
}
function alignAssignDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
    const assign_num2 = config.get<number>('assign_num2', 12);
    const assign_num3 = config.get<number>('assign_num3', 30);
    const assign_num4 = config.get<number>('assign_num4', 80);
    const regex = /^\s*assign\b\s+([^\s=]+)\s*=\s*([^;]+)\s*([;])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const signal = match[1].trim();
    const value = match[2].trim();
    const endSymbol = (match[3] || '').trim();
    const comment = (match[4] || '').trim();
    let currentLine = indent + 'assign';
    currentLine += ' '.repeat(Math.max(1, assign_num2 - currentLine.length));
    currentLine += signal;
    currentLine += ' '.repeat(Math.max(1, assign_num3 - currentLine.length));
    currentLine += '= ' + value;
    const endPart = (endSymbol || ';') + (comment ? ' ' + comment : '');
    if (endPart.trim()) {
        const spaces = Math.max(1, assign_num4 - currentLine.length);
        currentLine += ' '.repeat(spaces) + endPart;
    }
    return currentLine.trimEnd();
}
function alignInstanceSignal(line: string, config: vscode.WorkspaceConfiguration): string {
    const inst_num2 = config.get<number>('inst_num2', 40);
    const inst_num3 = config.get<number>('inst_num3', 80);
    const regex = /^\s*\.([^\s\(]+)\s*\(([^)]*)\)\s*([,])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const signal = match[1].trim();
    const connection = match[2].trim();
    const endSymbol = (match[3] || '').trim();
    const comment = (match[4] || '').trim();
    let currentLine = indent + `.${signal}`;
    currentLine += ' '.repeat(Math.max(1, inst_num2 - currentLine.length));
    currentLine += `(${connection})`;
    const endPart = endSymbol + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, inst_num3 - currentLine.length);
        currentLine += ' '.repeat(spaces) + endPart;
    }
    return currentLine.trimEnd();
}
function alignTwoDimArrayDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
    const array_num2 = config.get<number>('array_num2', 16);
    const array_num3 = config.get<number>('array_num3', 25);
    const array_num4 = config.get<number>('array_num4', 50);
    const array_num5 = config.get<number>('array_num5', 60);
    const array_num6 = config.get<number>('array_num6', 80);
    const regex = /^\s*(reg|wire)\s*(signed|unsigned)?\s*(\[[^\]]+\])\s*([^;,\s]+\s*(\[[^\]]+\]))\s*([;])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const type = (match[1] || '').trim();
    const signedUnsigned = (match[2] || '').trim();
    const width1 = (match[3] || '').trim();
    const signal = (match[4] || '').trim();
    const width2 = (match[5] || '').trim();
    const endSymbol = (match[6] || '').trim();
    const comment = (match[7] || '').trim();
    const alignedWidth1 = width1 ? alignBitWidthDeclarationRegex(width1, config) : '';
    const alignedWidth2 = width2 ? alignBitWidthDeclarationRegex(width2, config) : '';
    let currentLine = indent + type;
    currentLine += ' '.repeat(Math.max(1, array_num2 - currentLine.length));
    currentLine += signedUnsigned;
    currentLine += ' '.repeat(Math.max(1, array_num3 - currentLine.length));
    currentLine += alignedWidth1;
    currentLine += ' '.repeat(Math.max(1, array_num4 - currentLine.length));
    currentLine += signal;
    currentLine += ' '.repeat(Math.max(1, array_num5 - currentLine.length));
    currentLine += alignedWidth2;
    const endPart = (endSymbol || ';') + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, array_num6 - currentLine.length);
        currentLine += ' '.repeat(spaces) + endPart;
    }
    return currentLine.trimEnd();
}
function alignBitWidthDeclarationRegex(bitwidthString: string, config: vscode.WorkspaceConfiguration): string {
  const upbound = config.get('upbound', 2);
  const lowbound = config.get('lowbound', 2);
  const regex = /\[\s*([^:]+)\s*:\s*([^\]]+)\s*\]/;
  const match = bitwidthString.match(regex);
  if (!match) return bitwidthString;
  const up = match[1].trim();
  const low = match[2].trim();
  const alignedUp = up.padStart(Math.max(upbound, up.length), ' ');
  const alignedLow = low.padEnd(Math.max(lowbound, low.length), ' ');
  return `[${alignedUp}:${alignedLow}]`;
}
