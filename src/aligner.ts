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
    if (!node.start || !node.end) return '';
    const lines = fullText.split('\n');
    const startLine = node.start.line - 1;
    const endLine = node.end.line - 1;
    const startCol = node.start.column;
    const endCol = node.end.column;
    if (startLine < 0 || endLine >= lines.length || startLine > endLine) return '';
    if (startLine === endLine) return lines[startLine].substring(startCol, endCol);
    let extracted = lines[startLine].substring(startCol);
    for (let i = startLine + 1; i < endLine; i++) extracted += '\n' + lines[i];
    extracted += '\n' + lines[endLine].substring(0, endCol);
    return extracted.trim();
}

function reconstructExpressionText(node: ASTNode | undefined, context: FormattingContext): string {
    if (!node) return '';

    if (node.name === 'range_expression') {
        const colonIndex = node.children?.findIndex(c => c.name === 'COLON');
        if (colonIndex !== undefined && colonIndex > 0) {
            const msbNode = node.children![colonIndex - 1];
            const lsbNode = node.children![colonIndex + 1];
            const msbText = reconstructExpressionText(msbNode, context);
            const lsbText = reconstructExpressionText(lsbNode, context);
            return alignBitWidthDeclarationRegex(`${msbText}:${lsbText}`, context.config);
        }
    }

    if (node.value !== undefined) {
        if (node.name === 'NUMBER') return node.value.trim();
        return node.value;
    }

    if (node.children && node.children.length > 0) {
        let result = '';
        const noSpaceAfter = new Set(['[', '{', '.', '(', '`', '\'']); 
        const noSpaceBefore = new Set(['[', ']', '{', '}', '.', '(', ')', ',', ';', ':', '\'']); 
        
        for (const child of node.children) {
            const currentToken = reconstructExpressionText(child, context);
            if (!currentToken) continue;
            if (result.length > 0) {
                const lastCharOfResult = result.charAt(result.length - 1);
                const firstCharOfCurrent = currentToken.charAt(0);
                if (!(noSpaceAfter.has(lastCharOfResult) || noSpaceBefore.has(firstCharOfCurrent))) {
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
    const sortedComments = [...comments].sort((a, b) => a.originalTokenIndex - b.originalTokenIndex);
    sortedComments.forEach(comment => {
        if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
            const isBlockComment = comment.text.startsWith('/*');
            if (isBlockComment) {
                const commentLines = comment.text.split('\n');
                formatted += commentLines.map(l => (indentStr + l).trimEnd()).join('\n') + '\n';
            } else {
                formatted += (indentStr + comment.text).trimEnd() + '\n';
            }
            context.processedCommentIndices.add(comment.originalTokenIndex);
        }
    });
    return formatted;
}

function formatTrailingComments(comments: CommentInfo[] | undefined, context: FormattingContext): string {
    if (!comments) return '';
    let formatted: string[] = [];
    const sortedComments = [...comments].sort((a, b) => a.originalTokenIndex - b.originalTokenIndex);
    sortedComments.forEach(comment => {
        if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
            let text = comment.text.trim();
            if (text.startsWith('//') || text.replace(/\/\*|\*\/|\/\//g, '').trim()) {
                 if(text.startsWith('//')){
                    formatted.push(text);
                    context.processedCommentIndices.add(comment.originalTokenIndex);
                 }
            }
        }
    });
    return formatted.join(' ');
}

function findDeepTrailingComments(node: ASTNode): CommentInfo[] {
    let comments: CommentInfo[] = [];
    if (node.trailingComments) comments.push(...node.trailingComments);
    if (node.children) {
        for (let i = node.children.length - 1; i >= 0; i--) {
            comments.push(...findDeepTrailingComments(node.children[i]));
        }
    }
    const uniqueCommentsMap = new Map<number, CommentInfo>();
    comments.forEach(c => uniqueCommentsMap.set(c.originalTokenIndex, c));
    return Array.from(uniqueCommentsMap.values());
}

function formatASTNode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    if (!node || node.name === 'EOF') return '';
    const baseIndent = indentChar.repeat(indentLevel);
    let content = formatLeadingComments(node.leadingComments, baseIndent, context);

    switch (node.name) {
        case 'source_text':
            return content + (node.children || []).map(child => formatASTNode(child, config, indentLevel, context)).join('');
        case 'module_declaration':
            return content + formatModuleDeclaration(node, config, indentLevel, context);
        case 'define_directive':
        case 'include_directive':
        case 'timescale_directive':
        case 'ifdef_directive': {
            const code = formatPreprocessorDirective(node, config, indentLevel, context);
            const directTrailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
            return content + code.trimEnd() + (directTrailingComment ? ' ' + directTrailingComment : '') + '\n';
        }
        case 'module_item': {
            const itemNode = node.children?.find(c => c.name.endsWith('_construct') || c.name.endsWith('_instantiation') || c.name.endsWith('_declaration') || c.name.endsWith('_assign'));
            
            if (!itemNode) {
                const trailing = formatTrailingComments(findDeepTrailingComments(node), context);
                if (trailing) return content + baseIndent + trailing + '\n';
                return content;
            }

            if (itemNode.name.endsWith('_declaration') || itemNode.name.endsWith('_assign')) {
                let codeLine = formatASTNode(itemNode, config, indentLevel, context);
                const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
                let finalPart = ';' + (trailingComment ? ' ' + trailingComment : '');
                
                let alignColumn = 80;
                if (itemNode.name.includes('param')) alignColumn = config.get<number>('localparam_num4', 80);
                else if (itemNode.name.includes('assign')) alignColumn = config.get<number>('assign_num4', 80);
                else alignColumn = config.get<number>('signal_num5', 80);

                const spaces = Math.max(1, alignColumn - codeLine.length);
                codeLine += ' '.repeat(spaces) + finalPart;
                return content + codeLine + '\n';
            }
             
            return content + formatASTNode(itemNode, config, indentLevel, context);
        }
        case 'parameter_declaration':
        case 'localparam_declaration':
            return formatLocalParameterDeclaration(node, config, indentLevel, context);
        case 'reg_declaration':
        case 'wire_declaration':
        case 'integer_declaration':
        case 'real_declaration':
            return formatSignalsDeclaration(node, config, indentLevel, context);
        case 'continuous_assign':
             return formatContinuousAssign(node, config, indentLevel, context);
        case 'always_construct':
            return content + formatAlwaysConstruct(node, config, indentLevel, context);
        case 'module_instantiation':
            return content + formatModuleInstantiation(node, config, indentLevel, context);
        default:
            console.warn(`[formatASTNode] Unhandled node type: ${node.name}.`);
            return content;
    }
}

function formatModuleDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    let content = indent + 'module ' + getRawNodeText(findChild(node, 'IDENTIFIER'));
    const paramList = findChild(node, 'parameter_port_list');
    if (paramList) content += ' ' + formatParameterPortList(paramList, config, indentLevel, context);
    const portList = findChild(node, 'port_list');
    if (portList) content += '\n' + formatPortList(portList, config, indentLevel, context);
    content += ';\n';
    const headerItems = new Set(['MODULE', 'IDENTIFIER', 'parameter_port_list', 'port_list', 'SEMI', 'ENDMODULE']);
    const allBodyItems = (node.children || [])
        .filter(c => !headerItems.has(c.name))
        .sort((a,b) => (a.start?.line || 0) - (b.start?.line || 0));
    if (allBodyItems.length > 0) {
        content += '\n' + allBodyItems.map(item => formatASTNode(item, config, indentLevel + 1, context)).join('');
    }
    content += '\n' + indent + 'endmodule';
    const endmoduleNode = findChild(node, 'ENDMODULE');
    if (endmoduleNode) {
        const trailingComment = formatTrailingComments(findDeepTrailingComments(endmoduleNode), context);
        if (trailingComment) content += ' ' + trailingComment;
    }
    return content + '\n';
}

function formatParameterPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const paramIndentStr = indentChar.repeat(indentLevel + 1);
    const param_num2 = config.get<number>('param_num2', 25);
    const param_num3 = config.get<number>('param_num3', 50);
    const param_num4 = config.get<number>('param_num4', 80);

    const assignments = findAllChildren(node, 'param_assignment');
    if (assignments.length === 0) return '#()';

    interface ProcessedLineInfo {
        node: ASTNode;
        leadingComments: CommentInfo[];
        trailingComments: CommentInfo[];
    }

    const lineInfos: ProcessedLineInfo[] = assignments.map(p => ({
        node: p,
        leadingComments: p.leadingComments || [],
        trailingComments: findDeepTrailingComments(p)
    }));

    for (let i = 0; i < lineInfos.length - 1; i++) {
        const currentInfo = lineInfos[i];
        const nextInfo = lineInfos[i + 1];
        if (nextInfo.node.start!.line > currentInfo.node.end!.line) {
            if (nextInfo.leadingComments.length > 0) {
                currentInfo.trailingComments.push(...nextInfo.leadingComments);
                nextInfo.leadingComments = [];
            }
        }
    }

    const resultLines: string[] = [];
    for (let i = 0; i < lineInfos.length; i++) {
        const info = lineInfos[i];
        
        resultLines.push(formatLeadingComments(info.leadingComments, paramIndentStr, context).trimEnd());

        const keyword = getRawNodeText(findChild(info.node, 'PARAMETER'));
        const identifier = getRawNodeText(findChild(info.node, 'IDENTIFIER'));
        const value = reconstructExpressionText(findChild(info.node, 'primary'), context);
        let currentLine = paramIndentStr + keyword;
        currentLine += ' '.repeat(Math.max(1, param_num2 - currentLine.length)) + identifier;
        currentLine += ' '.repeat(Math.max(1, param_num3 - currentLine.length)) + '= ' + value;

        const trailingCommentText = formatTrailingComments(info.trailingComments, context);
        const isLast = (i === lineInfos.length - 1);
        const separator = isLast ? '' : ',';
        const finalPart = separator + (trailingCommentText ? ' ' + trailingCommentText : '');
        
        if (finalPart.trim()) {
            currentLine += ' '.repeat(Math.max(1, param_num4 - currentLine.length)) + finalPart;
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

    const portDecls = (node.children || []).filter(c => c.name.endsWith('_declaration')).sort((a,b) => a.start!.line - b.start!.line);
    if (portDecls.length === 0) return `${indent}()`;

    interface ProcessedLineInfo {
        node: ASTNode;
        leadingComments: CommentInfo[];
        trailingComments: CommentInfo[];
    }

    const lineInfos: ProcessedLineInfo[] = portDecls.map(decl => ({
        node: decl,
        leadingComments: decl.leadingComments || [],
        trailingComments: findDeepTrailingComments(decl)
    }));

    for (let i = 0; i < lineInfos.length - 1; i++) {
        const currentInfo = lineInfos[i];
        const nextInfo = lineInfos[i + 1];
        if (nextInfo.node.start!.line > currentInfo.node.end!.line) {
            if (nextInfo.leadingComments.length > 0) {
                currentInfo.trailingComments.push(...nextInfo.leadingComments);
                nextInfo.leadingComments = [];
            }
        }
    }
    
    const resultLines: string[] = [];
    for (let i = 0; i < lineInfos.length; i++) {
        const info = lineInfos[i];
        
        resultLines.push(formatLeadingComments(info.leadingComments, portIndent, context).trimEnd());

        let codeLine = formatPortDeclaration(info.node, config, indentLevel + 1, context);
        const trailingCommentText = formatTrailingComments(info.trailingComments, context);

        const isLast = (i === lineInfos.length - 1);
        const separator = isLast ? '' : ',';
        const finalPart = separator + (trailingCommentText ? " " + trailingCommentText : "");
        
        if (finalPart.trim()) {
            codeLine += ' '.repeat(Math.max(1, commentAlignColumn - codeLine.length)) + finalPart;
        } else {
            codeLine += separator;
        }
        resultLines.push(codeLine);
    }

    return `${indent}(\n${resultLines.filter(Boolean).join('\n')}\n${indent})`;
}

function formatPortDeclaration(declaration: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
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

function formatLocalParameterDeclaration(decl: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const localparam_num2 = config.get<number>('localparam_num2', 25);
    const localparam_num3 = config.get<number>('localparam_num3', 50);
    const keyword = getRawNodeText(findChild(decl, 'PARAMETER')) || getRawNodeText(findChild(decl, 'LOCALPARAM')) || 'parameter';
    const identifier = reconstructExpressionText(findChild(decl, 'list_of_identifiers'), context);
    const value = reconstructExpressionText(findChild(decl, 'primary'), context);
    
    let currentLine = indentStr + keyword;
    currentLine += ' '.repeat(Math.max(1, localparam_num2 - currentLine.length)) + identifier;
    currentLine += ' '.repeat(Math.max(1, localparam_num3 - currentLine.length)) + '= ' + value;
    return currentLine.trimEnd();
}

function formatSignalsDeclaration(decl: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    let type = '';
    if (decl.name === 'reg_declaration') type = 'reg';
    else if (decl.name === 'wire_declaration') type = 'wire';
    else if (decl.name === 'integer_declaration') type = 'integer';
    else if (decl.name === 'real_declaration') type = 'real';

    const signed = getRawNodeText(findChild(decl, 'SIGNED')) || '';
    const range = reconstructExpressionText(findChild(decl, 'range_expression'), context) || '';
    const identifier = reconstructExpressionText(findChild(decl, 'list_of_identifiers'), context);
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
    const expressionNode = node.children?.find(c => c.name.endsWith('expression'));
    if (!lvalueNode || !expressionNode) return `${indentStr}assign ; // Error: Could not parse.`;
    const lvalue = reconstructExpressionText(lvalueNode, context);
    const expression = reconstructExpressionText(expressionNode, context);
    
    let currentLine = indentStr + 'assign';
    currentLine += ' '.repeat(Math.max(1, assign_num2 - currentLine.length)) + lvalue;
    currentLine += ' '.repeat(Math.max(1, assign_num3 - currentLine.length)) + '= ' + expression;
    return currentLine;
}

function formatPreprocessorDirective(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);
    return baseIndent + reconstructExpressionText(node, context);
}

// =========================================================================
// STATEMENT AND INSTANTIATION HANDLING (FINALIZED AND CORRECTED)
// =========================================================================
interface StatementStyle { isKnrStyle?: boolean; isChainedIf?: boolean; }

function findAndStealBeginComment(node: ASTNode | undefined, context: FormattingContext): string {
    if (!node) return '';
    if (node.leadingComments && node.leadingComments.length > 0) {
        const commentText = formatTrailingComments(node.leadingComments, context);
        node.leadingComments = [];
        return commentText ? ' ' + commentText : '';
    }
    if (node.children && node.children.length > 0) {
        return findAndStealBeginComment(node.children[0], context);
    }
    return '';
}

function formatAlwaysConstruct(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const sensitivityList = reconstructExpressionText(findChild(node, 'event_control'), context);
    let content = baseIndent + 'always ' + sensitivityList.trim() + ' ';
    const bodyStatementNode = findChild(node, 'statement');
    if (bodyStatementNode) {
        content += formatStatement(bodyStatementNode, config, indentLevel, context, { isKnrStyle: true });
    } else { content += ';'; }
    return content + '\n\n';
}

function formatStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const itemIndent = indentChar.repeat(indentLevel);
    
    if (!node.children || node.children.length === 0 || node.children.every(c => c.name === 'SEMI')) {
        const leading = formatLeadingComments(node.leadingComments, itemIndent, context);
        const trailing = formatTrailingComments(findDeepTrailingComments(node), context);
        const combined = (leading.trim() + ' ' + trailing.trim()).trim();
        return combined ? itemIndent + combined : '';
    }
    
    const leadingComments = formatLeadingComments(node.leadingComments, itemIndent, context);
    let codeContent = '';
    const firstSemanticChild = node.children[0]; 

    switch (firstSemanticChild.name) {
        case 'BEGIN': 
            codeContent = formatBeginEnd(node, config, indentLevel, context, style); 
            break;
        case 'IF': 
            codeContent = formatIfStatement(node, config, indentLevel, context, style); 
            break;
        case 'FOR': 
            codeContent = formatForStatement(node, config, indentLevel, context, style); 
            break;
        case 'blocking_or_nonblocking_assignment':
        case 'procedural_assignment': {
            const always_lvalue_align = config.get<number>('always_lvalue_align', 20);
            const always_op_align = config.get<number>('always_op_align', 24);
            const lvalueNode = findChild(firstSemanticChild, 'variable_lvalue');
            const opNode = findChild(firstSemanticChild, 'LE_OP') || findChild(firstSemanticChild, 'ASSIGN_EQ');
            const rvalueNode = firstSemanticChild.children?.find(c => c.name.endsWith('expression') || c.name === 'primary' || c.name === 'concatenation');
            if (lvalueNode && opNode && rvalueNode) {
                const lvalue = reconstructExpressionText(lvalueNode, context);
                const op = opNode.value || '<=';
                const rvalue = reconstructExpressionText(rvalueNode, context);
                let line = itemIndent + lvalue;
                line += ' '.repeat(Math.max(1, always_lvalue_align - line.length)) + op;
                line += ' '.repeat(Math.max(1, always_op_align - line.length)) + rvalue;
                codeContent = line + ';';
            } else {
                codeContent = `${itemIndent}${reconstructExpressionText(firstSemanticChild, context)};`;
            }
            break;
        }
        case 'SEMI': 
            codeContent = `${itemIndent};`; 
            break;
        default: 
            codeContent = `${itemIndent}${extractOriginalText(node, context.originalText)}`; 
            break;
    }

    const trailingComment = formatTrailingComments(findDeepTrailingComments(node), context);
    if (trailingComment) {
        codeContent = codeContent.trimEnd() + ' ' + trailingComment;
    }
    return (leadingComments + codeContent).trimEnd();
}

function formatBeginEnd(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    let trailingCommentOnBegin = '';
    const statementsInBlock = node.children?.filter(c => c.name === 'statement') || [];
    const firstStatementWrapper = statementsInBlock[0];
    if (style.isKnrStyle && firstStatementWrapper) {
        trailingCommentOnBegin = findAndStealBeginComment(firstStatementWrapper, context);
    }
    let content = style.isKnrStyle ? 'begin' + trailingCommentOnBegin : `\n${baseIndent}begin`;
    if (statementsInBlock.length > 0) {
        const formattedStatements = statementsInBlock
            .map(s => formatStatement(s, config, indentLevel + 1, context, {}))
            .filter(Boolean)
            .join('\n');
        if (formattedStatements) {
            content += '\n' + formattedStatements + '\n' + baseIndent;
        }
    }
    content += 'end';
    return content;
}

function formatIfStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const ifIndentStr = style.isChainedIf ? '' : baseIndent;
    const ifChildren = node.children || [];
    const lparenIndex = ifChildren.findIndex(c => c.name === 'LPAREN');
    const rparenIndex = ifChildren.findIndex(c => c.name === 'RPAREN');
    const conditionNodes = ifChildren.slice(lparenIndex + 1, rparenIndex);
    const conditionText = conditionNodes.map(n => reconstructExpressionText(n, context)).join(' ');
    const elseTokenIndex = ifChildren.findIndex(c => c.name === 'ELSE');
    const thenClause = ifChildren[rparenIndex + 1];
    const elseClause = (elseTokenIndex !== -1) ? ifChildren[elseTokenIndex + 1] : undefined;

    let content = ifIndentStr + 'if (' + conditionText + ')';

    if (thenClause && thenClause.name === 'statement') {
        content += ' ' + formatStatement(thenClause, config, indentLevel, context, { isKnrStyle: true });
    } else {
        content += ';';
    }
    
    if (elseClause && elseClause.name === 'statement') {
        const isElseIf = elseClause.children?.some(c => c.name === 'IF');
        content += `\n${baseIndent}else`;
        if (isElseIf) {
            content += ' ' + formatStatement(elseClause, config, indentLevel, context, { isChainedIf: true });
        } else {
            content += ' ' + formatStatement(elseClause, config, indentLevel, context, { isKnrStyle: true });
        }
    }
    return content;
}

function formatForStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const forChildren = node.children || [];
    const lparenIndex = forChildren.findIndex(c => c.name === 'LPAREN');
    const firstSemiIndex = forChildren.findIndex(c => c.name === 'SEMI');
    const secondSemiIndex = forChildren.findIndex((c, i) => c.name === 'SEMI' && i > firstSemiIndex);
    const rparenIndex = forChildren.findIndex(c => c.name === 'RPAREN');
    if (lparenIndex === -1 || firstSemiIndex === -1 || secondSemiIndex === -1 || rparenIndex === -1 || forChildren.length <= rparenIndex + 1) {
        return baseIndent + extractOriginalText(node, context.originalText);
    }
    const initNodes = forChildren.slice(lparenIndex + 1, firstSemiIndex);
    const condNodes = forChildren.slice(firstSemiIndex + 1, secondSemiIndex);
    const stepNodes = forChildren.slice(secondSemiIndex + 1, rparenIndex);
    const initPart = initNodes.map(n => reconstructExpressionText(n, context)).join(' ');
    const condPart = condNodes.map(n => reconstructExpressionText(n, context)).join(' ');
    const stepPart = stepNodes.map(n => reconstructExpressionText(n, context)).join(' ');
    const headerContent = baseIndent + `for (${initPart}; ${condPart}; ${stepPart})`;
    const bodyStatementNode = forChildren[rparenIndex + 1];
    const bodyContent = formatStatement(bodyStatementNode, config, indentLevel, context, { isKnrStyle: true });
    return headerContent + ' ' + bodyContent;
}

// **MODIFICATION - Final implementation for instantiation formatting**

interface LineInfo {
    node: ASTNode;
    leadingComments: CommentInfo[];
    trailingComments: CommentInfo[];
}

/**
 * Pre-processes a list of items (parameters or ports) to re-associate comments.
 * Mis-attributed leading comments (like line-end comments from the previous line)
 * are moved to the trailing comments of the correct (previous) node.
 * @param items - The list of AST nodes (e.g., named_parameter_assignment).
 * @returns A list of processed LineInfo objects with corrected comment associations.
 */
function reassociateComments(items: ASTNode[]): LineInfo[] {
    if (!items || items.length === 0) return [];

    const lineInfos: LineInfo[] = items.map(item => ({
        node: item,
        leadingComments: [...(item.leadingComments || [])],
        trailingComments: [...(item.trailingComments || [])]
    }));

    for (let i = 0; i < lineInfos.length - 1; i++) {
        const currentInfo = lineInfos[i];
        const nextInfo = lineInfos[i + 1];
        
        const misattributedComments = nextInfo.leadingComments.filter(comment => 
            comment.text.startsWith('//')
        );

        if (misattributedComments.length > 0) {
            currentInfo.trailingComments.push(...misattributedComments);
            nextInfo.leadingComments = nextInfo.leadingComments.filter(c => !misattributedComments.includes(c));
        }
    }
    return lineInfos;
}

function formatInstantiationParameters(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const paramIndent = indentChar.repeat(indentLevel + 1);
    
    const listNode = findChild(node, 'list_of_param_assignments');
    if (!listNode || !listNode.children) return '#()';

    // **FIX: Corrected function name from 'allListChildren' to 'findAllChildren'**
    const paramAssignments = findAllChildren(listNode, 'named_parameter_assignment');
    if (paramAssignments.length === 0) return '#()';

    const inst_param_align_lparen = config.get<number>('inst_param_align_lparen', 40);
    const inst_param_align_rparen = config.get<number>('inst_param_align_rparen', 80);

    const processedInfos = reassociateComments(paramAssignments);

    const resultLines: string[] = [];
    for (let i = 0; i < processedInfos.length; i++) {
        const info = processedInfos[i];
        const assign = info.node;

        // Print any genuine leading comments (like block comments) first.
        const leadingCommentText = formatLeadingComments(info.leadingComments, paramIndent, context);
        if (leadingCommentText.trim()) {
            resultLines.push(leadingCommentText.trimEnd());
        }
        
        // Build the code line.
        const paramName = getRawNodeText(findChild(assign, 'IDENTIFIER'));
        const paramValue = reconstructExpressionText(findChild(assign, 'primary'), context);
        
        let codeLine = `${paramIndent}.${paramName}`;
        codeLine += ' '.repeat(Math.max(1, inst_param_align_lparen - codeLine.length)) + `(${paramValue}`;
        codeLine += ' '.repeat(Math.max(1, inst_param_align_rparen - codeLine.length - 1)) + ')';
        
        const isLast = i === processedInfos.length - 1;
        codeLine += isLast ? '' : ',';
        
        // Format all trailing comments.
        const allTrailingComments = [...info.trailingComments];
        const rparenNode = findChild(assign, 'RPAREN');
        if (rparenNode?.trailingComments) {
            allTrailingComments.push(...rparenNode.trailingComments);
        }
        const trailingCommentText = formatTrailingComments(allTrailingComments, context);

        if (trailingCommentText) {
            codeLine += ' ' + trailingCommentText;
        }

        resultLines.push(codeLine.trimEnd());
    }

    return `#(\n${resultLines.join('\n')}\n${indent})`;
}

function formatInstantiationPorts(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const portIndent = indentChar.repeat(indentLevel + 1);

    const listNode = findChild(node, 'list_of_port_connections');
    if (!listNode || !listNode.children) return '()';

    const portConnections = findAllChildren(listNode, 'named_port_connection');
    if (portConnections.length === 0) return '()';

    const inst_port_align_name = config.get<number>('inst_port_align_name', 24);
    const inst_port_align_lparen = config.get<number>('inst_port_align_lparen', 40);
    const inst_port_align_rparen = config.get<number>('inst_port_align_rparen', 80);

    const processedInfos = reassociateComments(portConnections);

    const resultLines: string[] = [];
    for (let i = 0; i < processedInfos.length; i++) {
        const info = processedInfos[i];
        const conn = info.node;
        
        // Print any genuine leading comments (like block comments) first.
        const leadingCommentText = formatLeadingComments(info.leadingComments, portIndent, context);
        if (leadingCommentText.trim()) {
            resultLines.push(leadingCommentText.trimEnd());
        }

        // Build the code line.
        const portName = getRawNodeText(findChild(conn, 'IDENTIFIER'));
        const portSignal = reconstructExpressionText(findChild(conn, 'primary') || findChild(conn, 'logical_and_expression'), context);
        
        let codeLine = `${portIndent}.${portName}`;
        codeLine += ' '.repeat(Math.max(1, inst_port_align_name - codeLine.length));
        codeLine += ' '.repeat(Math.max(1, inst_port_align_lparen - codeLine.length)) + `(${portSignal}`;
        codeLine += ' '.repeat(Math.max(1, inst_port_align_rparen - codeLine.length - 1)) + ')';

        const isLast = i === processedInfos.length - 1;
        codeLine += isLast ? '' : ',';
        
        // Format all trailing comments.
        const allTrailingComments = [...info.trailingComments];
        const rparenNode = findChild(conn, 'RPAREN');
        if (rparenNode?.trailingComments) {
            allTrailingComments.push(...rparenNode.trailingComments);
        }
        const trailingCommentText = formatTrailingComments(allTrailingComments, context);
        if (trailingCommentText) {
            codeLine += ' ' + trailingCommentText;
        }
        
        resultLines.push(codeLine.trimEnd());
    }
    return `(\n${resultLines.join('\n')}\n${indent})`;
}

function formatModuleInstantiation(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const moduleName = getRawNodeText(findChild(node, 'IDENTIFIER'));
    const paramAssignmentNode = findChild(node, 'parameter_value_assignment');
    const instanceNode = findChild(node, 'module_instance');

    let content = baseIndent + moduleName;

    if (paramAssignmentNode) {
        content += ' ' + formatInstantiationParameters(paramAssignmentNode, config, indentLevel, context);
    }
    
    if (instanceNode) {
        const instanceNameNode = findChild(instanceNode, 'name_of_instance');
        const instanceName = instanceNameNode ? getRawNodeText(findChild(instanceNameNode, 'IDENTIFIER')) : '';
        if(instanceName) {
            content += ` ${instanceName}`;
        }
        content += ' ' + formatInstantiationPorts(instanceNode, config, indentLevel, context);
    }

    return content + ';\n\n';
}

// =========================================================================
// REGEX-BASED FALLBACK MODE FUNCTIONS (COMPLETE AND UNABBREVIATED)
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
    const alignedWidth = width ? alignBitWidthDeclarationRegex(width.slice(1, -1), config) : '';
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
    const alignedWidth = width ? alignBitWidthDeclarationRegex(width.slice(1, -1), config) : '';
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
    const alignedWidth1 = width1 ? alignBitWidthDeclarationRegex(width1.slice(1, -1), config) : '';
    const alignedWidth2 = width2 ? alignBitWidthDeclarationRegex(width2.slice(1, -1), config) : '';
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

function alignBitWidthDeclarationRegex(bitwidthContent: string, config: vscode.WorkspaceConfiguration): string {
    const upbound = config.get<number>('upbound', 2);
    const lowbound = config.get<number>('lowbound', 2);
    
    if (!bitwidthContent.includes(':')) return '';

    const parts = bitwidthContent.split(':');
    const up = parts[0].trim();
    const low = parts[1].trim();

    const alignedUp = up.padStart(Math.max(upbound, up.length), ' ');
    const alignedLow = low.padEnd(Math.max(lowbound, low.length), ' ');

    return `[${alignedUp}:${alignedLow}]`;
}
