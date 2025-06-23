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
    return extracted;
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
        const noSpaceAfter = new Set(['[', '{', '.', '(', '`', '\'', '!', '~', '$']); 
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

function formatDeclarationLine(
    node: ASTNode,
    codeFormatter: (node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext) => string,
    getTrailingPart: (node: ASTNode, context: FormattingContext) => string,
    alignColumn: number,
    indentLevel: number,
    context: FormattingContext
): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const leadingComments = formatLeadingComments(node.leadingComments, baseIndent, context);
    const codePart = codeFormatter(node, context.config, indentLevel, context);
    const trailingPart = getTrailingPart(node, context);
    let finalLine = codePart;
    if (trailingPart.trim()) {
        finalLine += ' '.repeat(Math.max(1, alignColumn - finalLine.length)) + trailingPart;
    }
    return (leadingComments + finalLine).trimEnd();
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
            const trailingComment = formatTrailingComments(node.trailingComments, context);
            return content + code.trimEnd() + (trailingComment ? ' ' + trailingComment : '') + '\n';
        }
        case 'module_item': {
            const itemNode = node.children?.[0];
            if (!itemNode) {
                const trailing = formatTrailingComments(findChild(node, 'SEMI')?.trailingComments, context);
                if (trailing) content += baseIndent + trailing + '\n';
                return content;
            }

            if (itemNode.name.endsWith('_declaration') || itemNode.name.endsWith('_assign')) {
                const getTrailingPart = (n: ASTNode, ctx: FormattingContext) => {
                    const trailingComment = formatTrailingComments(node.trailingComments, ctx);
                    return ';' + (trailingComment ? ' ' + trailingComment : '');
                };

                let formatterFn: (n: ASTNode, cfg: vscode.WorkspaceConfiguration, i: number, ctx: FormattingContext) => string;
                let alignConfigKey: string;

                if (itemNode.name.includes('param')) {
                    formatterFn = formatLocalParameterDeclarationCode;
                    alignConfigKey = 'localparam_num4';
                } else if (itemNode.name.includes('assign')) {
                    formatterFn = formatContinuousAssignCode;
                    alignConfigKey = 'assign_num4';
                } else {
                    formatterFn = formatSignalsDeclarationCode;
                    alignConfigKey = 'signal_num5';
                }
                
                content += formatDeclarationLine(
                    itemNode, formatterFn, getTrailingPart, config.get<number>(alignConfigKey, 80),
                    indentLevel, context
                ) + '\n';
            } else {
                 content += formatASTNode(itemNode, config, indentLevel, context);
            }
            return content;
        }
        case 'always_construct':
            return content + formatAlwaysConstruct(node, config, indentLevel, context);
        case 'initial_construct':
            return content + formatInitialConstruct(node, config, indentLevel, context);
        case 'module_instantiation':
            return content + formatModuleInstantiation(node, config, indentLevel, context);
        default:
            const rawText = extractOriginalText(node, context.originalText).trim();
            if (rawText) {
                const trailingComment = formatTrailingComments(node.trailingComments, context);
                return content + baseIndent + rawText + (trailingComment ? ' ' + trailingComment : '') + '\n';
            }
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
        const trailingComment = formatTrailingComments(endmoduleNode.trailingComments, context);
        if (trailingComment) content += ' ' + trailingComment;
    }
    return content + '\n';
}

function collectAllTrailingComments(node: ASTNode | undefined, context: FormattingContext): string {
    if (!node) return '';

    let allComments: CommentInfo[] = [];

    // 递归函数
    function findComments(currentNode: ASTNode) {
        if (currentNode.trailingComments) {
            allComments.push(...currentNode.trailingComments);
        }
        if (currentNode.children) {
            // 从后往前遍历子节点，因为行尾注释更有可能在后面的节点上
            for (let i = currentNode.children.length - 1; i >= 0; i--) {
                findComments(currentNode.children[i]);
            }
        }
    }

    findComments(node);

    // 去重并格式化
    const uniqueComments = allComments.filter((comment, index, self) => 
        index === self.findIndex(c => c.originalTokenIndex === comment.originalTokenIndex)
    );
    
    return formatTrailingComments(uniqueComments, context);
}

// 找到并替换 formatParameterPortList 函数
function formatParameterPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const assignments = findAllChildren(node, 'param_assignment');
    if (assignments.length === 0) return '#()';

    reassociateTrailingLineComments(assignments);

    const resultLines: string[] = [];
    for (let i = 0; i < assignments.length; i++) {
        const assignment = assignments[i];
        
        // --- 核心修正：使用新的辅助函数来获取注释 ---
        const getTrailingPart = (n: ASTNode, ctx: FormattingContext) => {
            const isLast = (i === assignments.length - 1);
            const separator = isLast ? '' : ',';
            // 使用新函数来收集当前行节点(n)内部所有的行尾注释
            const trailingCommentText = collectAllTrailingComments(n, ctx);
            return separator + (trailingCommentText ? ' ' + trailingCommentText : '');
        };

        const line = formatDeclarationLine(
            assignment, formatParamAssignmentCode, getTrailingPart,
            config.get<number>('param_num4', 80), indentLevel + 1, context
        );
        resultLines.push(line);
    }
    
    const rParenNode = findChild(node, 'RPAREN');
    const remainingLeadingCommentsOnRParen = rParenNode ? formatLeadingComments(rParenNode.leadingComments, indent, context) : '';
    const endLine = (remainingLeadingCommentsOnRParen ? '\n' + remainingLeadingCommentsOnRParen.trimEnd() : '') + `\n${indent})`; // 注意这里要把 ')' 加回来
    
    return `#(\n${resultLines.filter(Boolean).join('\n')}${endLine}`;
}

function reassociateTrailingLineComments(items: ASTNode[]): void {
    if (!items || items.length < 2) {
        return;
    }
    for (let i = 0; i < items.length - 1; i++) {
        const currentItem = items[i];
        const nextItem = items[i + 1];

        if (!currentItem.end || !nextItem.leadingComments || nextItem.leadingComments.length === 0) {
            continue;
        }

        // 寻找所有需要移动的行注释。它们通常是下一项的前置注释中的第一个或前几个。
        const commentsToMove: CommentInfo[] = [];
        let firstNonMovableCommentIndex = -1;

        for (let j = 0; j < nextItem.leadingComments.length; j++) {
            const comment = nextItem.leadingComments[j];
            // 关键修正：如果一个注释是行注释(//)，我们就认为它应该被移动。
            // 这是一个非常可靠的启发式方法，因为列表项的前置注释几乎不应该是行注释。
            if (comment.text.startsWith('//')) {
                commentsToMove.push(comment);
            } else {
                // 一旦遇到块注释(/**/)或非注释内容，就停止移动。
                firstNonMovableCommentIndex = j;
                break;
            }
        }
        
        if (commentsToMove.length > 0) {
            if (!currentItem.trailingComments) {
                currentItem.trailingComments = [];
            }
            // 将找到的注释移动到当前项的尾部
            currentItem.trailingComments.push(...commentsToMove);

            // 从下一项的前置注释中移除已移动的注释
            if (firstNonMovableCommentIndex !== -1) {
                nextItem.leadingComments = nextItem.leadingComments.slice(firstNonMovableCommentIndex);
            } else {
                // 如果所有前置注释都被移动了
                nextItem.leadingComments = [];
            }
        }
    }
}

function formatPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const portDecls = (node.children || []).filter(c => c.name.endsWith('_declaration')).sort((a,b) => (a.start?.line || 0) - (b.start?.line || 0));
    if (portDecls.length === 0) return `${indent}()`;

    reassociateTrailingLineComments(portDecls);

    const resultLines: string[] = [];
    for (let i = 0; i < portDecls.length; i++) {
        const decl = portDecls[i];
        
        // --- 核心修正：使用新的辅助函数来获取注释 ---
        const getTrailingPart = (n: ASTNode, ctx: FormattingContext) => {
            const isLast = (i === portDecls.length - 1);
            const separator = isLast ? '' : ',';
            const trailingCommentText = collectAllTrailingComments(n, ctx);
            return separator + (trailingCommentText ? " " + trailingCommentText : "");
        };

        const line = formatDeclarationLine(
            decl, formatPortDeclarationCode, getTrailingPart,
            config.get<number>('port_num5', 80), indentLevel + 1, context
        );
        resultLines.push(line);
    }
    
    const rParenNode = findChild(node, 'RPAREN');
    const remainingLeadingCommentsOnRParen = rParenNode ? formatLeadingComments(rParenNode.leadingComments, indent, context) : '';
    const endLine = (remainingLeadingCommentsOnRParen ? '\n' + remainingLeadingCommentsOnRParen.trimEnd() : '') + `\n${indent})`; // 注意这里要把 ')' 加回来

    return `(\n${resultLines.filter(Boolean).join('\n')}${endLine}`;
}

function formatPortDeclarationCode(declaration: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
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

function formatParamAssignmentCode(assignment: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const param_num2 = config.get<number>('param_num2', 25);
    const param_num3 = config.get<number>('param_num3', 50);
    
    const keyword = getRawNodeText(findChild(assignment, 'PARAMETER'));
    const identifier = getRawNodeText(findChild(assignment, 'IDENTIFIER'));
    const value = reconstructExpressionText(findChild(assignment, 'primary'), context);
    
    let currentLine = indentStr + keyword;
    currentLine += ' '.repeat(Math.max(1, param_num2 - currentLine.length)) + identifier;
    currentLine += ' '.repeat(Math.max(1, param_num3 - currentLine.length)) + '= ' + value;
    return currentLine;
}

function formatLocalParameterDeclarationCode(decl: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const localparam_num2 = config.get<number>('localparam_num2', 25);
    const localparam_num3 = config.get<number>('localparam_num3', 50);
    const keyword = getRawNodeText(findChild(decl, 'PARAMETER')) || getRawNodeText(findChild(decl, 'LOCALPARAM')) || 'parameter';
    const identifier = reconstructExpressionText(findChild(decl, 'list_of_identifiers'), context);
    const value = reconstructExpressionText(findChild(decl, 'primary'), context);
    
    let currentLine = indentStr + keyword;
    currentLine += ' '.repeat(Math.max(1, localparam_num2 - currentLine.length)) + identifier;
    currentLine += ' '.repeat(Math.max(1, localparam_num3 - currentLine.length)) + '= ' + value;
    return currentLine;
}

function formatSignalsDeclarationCode(decl: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
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
    currentLine += ' '.repeat(Math.max(1, signal_num2 - currentLine.length)) + signed;
    currentLine += ' '.repeat(Math.max(1, signal_num3 - currentLine.length)) + range;
    currentLine += ' '.repeat(Math.max(1, signal_num4 - currentLine.length)) + identifier;
    return currentLine;
}

function formatContinuousAssignCode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const assign_num2 = config.get<number>('assign_num2', 12);
    const assign_num3 = config.get<number>('assign_num3', 30);
    const lvalueNode = findChild(node, 'variable_lvalue') || findChild(node, 'net_lvalue');
    
    const expressionNode = node.children?.find(c => c.name.endsWith('expression') || c.name === 'concatenation');
    
    if (!lvalueNode || !expressionNode) {
        return indentStr + 'assign';
    }
    
    const lvalue = reconstructExpressionText(lvalueNode, context);
    const expression = reconstructExpressionText(expressionNode, context);
    
    let currentLine = indentStr + 'assign';
    currentLine += ' '.repeat(Math.max(1, assign_num2 - currentLine.length)) + lvalue;
    currentLine += ' '.repeat(Math.max(1, assign_num3 - currentLine.length)) + '= ' + expression;
    return currentLine;
}

function formatPreprocessorDirective(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const alignCol1 = config.get<number>('preprocessor_col1', 12);
    const alignCol2 = config.get<number>('preprocessor_col2', 24);

    let currentLine = '';

    switch (node.name) {
        case 'define_directive': {
            const directive = getRawNodeText(findChild(node, 'TICK_DEFINE'));
            const macroName = getRawNodeText(findChild(node, 'MACRO_IDENTIFIER'));
            const macroBody = getRawNodeText(findChild(node, 'MACRO_BODY'))?.trim();
            
            currentLine = baseIndent + directive;
            if (macroName) {
                currentLine += ' '.repeat(Math.max(1, alignCol1 - currentLine.length)) + macroName;
            }
            if (macroBody) {
                currentLine += ' '.repeat(Math.max(1, alignCol2 - currentLine.length)) + macroBody;
            }
            return currentLine;
        }

        case 'timescale_directive': {
            const directive = getRawNodeText(findChild(node, 'TICK_TIMESCALE'));
            const value = getRawNodeText(findChild(node, 'TIMESCALE_VALUE'))?.trim();

            currentLine = baseIndent + directive;
            if (value) {
                currentLine += ' '.repeat(Math.max(1, alignCol1 - currentLine.length)) + value;
            }
            return currentLine;
        }

        case 'include_directive': {
            const directive = getRawNodeText(findChild(node, 'TICK_INCLUDE'));
            const filename = getRawNodeText(findChild(node, 'STRING'))?.trim();

            currentLine = baseIndent + directive;
            if (filename) {
                currentLine += ' '.repeat(Math.max(1, alignCol1 - currentLine.length)) + filename;
            }
            return currentLine;
        }
        
        case 'ifdef_directive': {
            const lines: string[] = [];
            const children = node.children || [];
            
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                let line = '';
                
                if (child.name === 'TICK_IFDEF' || child.name === 'TICK_IFNDEF' || child.name === 'TICK_ELSIF') {
                    line = baseIndent + child.value;
                    if (i + 1 < children.length && children[i + 1].name === 'IDENTIFIER') {
                        const identifier = children[i + 1].value;
                        line += ' '.repeat(Math.max(1, alignCol1 - line.length)) + identifier;
                        i++; 
                    }
                    lines.push(line);
                } else if (child.name === 'TICK_ELSE' || child.name === 'TICK_ENDIF') {
                    line = baseIndent + child.value;
                    lines.push(line);
                }
            }
            return lines.join('\n');
        }

        default:
            return baseIndent + reconstructExpressionText(node, context);
    }
}

// =========================================================================
// STATEMENT AND INSTANTIATION HANDLING (FINAL, ROBUST VERSION)
// =========================================================================
interface StatementStyle { isKnrStyle?: boolean; isChainedIf?: boolean; }

function formatInitialConstruct(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);
    let content = baseIndent + 'initial';

    // In an initial block, the body can be a single statement or a begin-end block.
    const bodyNode = findChild(node, 'statement');
    if (!bodyNode) {
        return content + ';\n';
    }

    const bodyContent = formatStatement(bodyNode, config, indentLevel, context, { isKnrStyle: true });
    
    return content + ' ' + bodyContent.trim() + '\n';
}

function formatAlwaysConstruct(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const baseIndent = indentChar.repeat(indentLevel);
    let content = baseIndent + 'always';
    let bodyContent = '';

    const eventControlNode = findChild(node, 'event_control');
    const procTimeControlNode = findChild(node, 'procedural_timing_control_statement');
    const statementNode = findChild(node, 'statement');

    if (eventControlNode) {
        content += ' ' + reconstructExpressionText(eventControlNode, context);
        const trailingComment = formatTrailingComments(eventControlNode.trailingComments, context);
        if (trailingComment) {
            content += ' ' + trailingComment;
        }
        if (statementNode) {
            bodyContent = formatStatement(statementNode, config, indentLevel, context, { isKnrStyle: true });
        }
    } else if (procTimeControlNode) {
        // This case handles `always #10 a = b;`
        bodyContent = formatExecutableNode(procTimeControlNode, config, indentLevel, context, { isKnrStyle: true });
    } else if (statementNode) {
        bodyContent = formatStatement(statementNode, config, indentLevel, context, { isKnrStyle: true });
    }

    if (bodyContent.trim()) {
        return content + ' ' + bodyContent.trim() + '\n';
    }
    
    return content + ';\n';
}

// Universal formatter for any node inside a begin-end block or similar structure.
function formatExecutableNode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const itemIndent = indentChar.repeat(indentLevel);
    const leadingComments = formatLeadingComments(node.leadingComments, style.isChainedIf ? '' : itemIndent, context);

    let codeContent = '';
    
    switch (node.name) {
        case 'statement':
            codeContent = formatStatement(node, config, indentLevel, context, style);
            break;
        case 'procedural_timing_control_statement':
        case 'wait_statement':
            codeContent = formatSimpleStatement(node, config, indentLevel, context);
            break;
        default:
            // Fallback for any other unexpected top-level executable nodes
            codeContent = itemIndent + extractOriginalText(node, context.originalText).trim();
            break;
    }
    
    return (leadingComments + codeContent).trimEnd();
}


function formatStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const firstSemanticChild = node.children?.find(c => c.name && c.name !== 'SEMI');
    if (!firstSemanticChild) {
        const itemIndent = indentChar.repeat(indentLevel);
        const trailingComment = formatTrailingComments(findChild(node, 'SEMI')?.trailingComments, context);
        return ((style.isChainedIf ? '' : itemIndent) + ';' + (trailingComment ? ' ' + trailingComment : '')).trimEnd();
    }
    
    let codeContent = '';
    
    switch (firstSemanticChild.name) {
        case 'BEGIN': // This is a begin-end block statement
            return formatBeginEnd(node, config, indentLevel, context, style);
        case 'IF':
            return formatIfStatement(node, config, indentLevel, context, style);
        case 'FOR':
            return formatForStatement(node, config, indentLevel, context, style);
        case 'REPEAT':
            return formatRepeatStatement(node, config, indentLevel, context, style);
        
        case 'blocking_or_nonblocking_assignment':
            codeContent = formatAssignmentStatement(firstSemanticChild, config, indentLevel, context);
            break;
        
        default:
            // This covers system calls like $display, $stop etc.
            codeContent = formatSimpleStatement(node, config, indentLevel, context);
            break;
    }

    const trailingCommentOnNode = formatTrailingComments(node.trailingComments, context);
    const semiNode = findChild(node, 'SEMI');
    const semiTrailingComment = semiNode ? formatTrailingComments(semiNode.trailingComments, context) : '';
    const finalComment = [trailingCommentOnNode, semiTrailingComment].filter(Boolean).join(' ');

    if (finalComment) {
        const commentAlign = config.get<number>('always_comment_align', 80);
        let contentToPad = codeContent;
        if (contentToPad.endsWith(';')) {
            contentToPad = contentToPad.slice(0, -1).trimEnd();
        }
        codeContent = contentToPad + ' '.repeat(Math.max(1, commentAlign - contentToPad.length)) + finalComment;
    }

    if (!codeContent.trim().endsWith(';')) {
        codeContent += ';';
    }

    return codeContent;
}

function formatAssignmentStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const itemIndent = indentChar.repeat(indentLevel);
    const always_lvalue_align = config.get<number>('always_lvalue_align', 28);
    const op_align = config.get<number>('always_op_align', 32);

    const lvalueNode = findChild(node, 'variable_lvalue') || findChild(node, 'net_lvalue');
    const opNode = findChild(node, 'LE_OP') || findChild(node, 'ASSIGN_EQ');
    const rvalueNode = node.children?.find(c => c.name.endsWith('expression') || c.name === 'primary' || c.name === 'concatenation' || c.name === 'system_task_call');
    
    let codePart;
    if (lvalueNode && opNode && rvalueNode) {
        const lvalue = reconstructExpressionText(lvalueNode, context);
        const op = opNode.value || '<=';
        const rvalue = reconstructExpressionText(rvalueNode, context);
        
        let line = itemIndent + lvalue;
        line += ' '.repeat(Math.max(1, always_lvalue_align - line.length)) + op;
        line += ' '.repeat(Math.max(1, op_align - line.length)) + rvalue;
        codePart = line;
    } else {
        codePart = `${itemIndent}${extractOriginalText(node, context.originalText).trim()}`;
    }
    
    return codePart;
}

function formatSimpleStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const itemIndent = indentChar.repeat(indentLevel);
    const rawStatementText = extractOriginalText(node, context.originalText).trim();
    return itemIndent + rawStatementText;
}

function findAndExtractFirstLineComment(node: ASTNode | undefined, context: FormattingContext): string {
    if (!node) return '';

    if (node.leadingComments && node.leadingComments.length > 0) {
        const comment = node.leadingComments[0];
        if (comment.text.startsWith('//') && !context.processedCommentIndices.has(comment.originalTokenIndex)) {
            context.processedCommentIndices.add(comment.originalTokenIndex);
            return ' ' + comment.text.trim();
        }
    }
    
    if (node.children && node.children.length > 0) {
        return findAndExtractFirstLineComment(node.children[0], context);
    }
    
    return '';
}

function formatBeginEnd(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const innerIndentLevel = indentLevel + 1;
    let content = (style.isKnrStyle ? '' : `\n${baseIndent}`) + 'begin';

    const beginNode = findChild(node, 'BEGIN');
    let trailingCommentText = beginNode ? formatTrailingComments(beginNode.trailingComments, context) : '';
    
    // **THE ULTIMATE FIX IS HERE**: Iterate over ALL children between BEGIN and END, not just 'statement' nodes.
    const children = node.children || [];
    const beginIndex = children.findIndex(c => c.name === 'BEGIN');
    const endIndex = children.findIndex(c => c.name === 'END');
    
    const executableNodes = children.slice(beginIndex + 1, endIndex);

    if (!trailingCommentText && executableNodes.length > 0) {
        trailingCommentText = findAndExtractFirstLineComment(executableNodes[0], context);
    }
    
    if (trailingCommentText) {
        content += trailingCommentText;
    }

    if (executableNodes.length > 0) {
        const formattedStatements = executableNodes.map(sNode => 
            formatExecutableNode(sNode, config, innerIndentLevel, context, {})
        ).filter(Boolean).join('\n');
        
        if (formattedStatements.trim()) {
            content += '\n' + formattedStatements;
        }
    }
    
    const endNode = children[endIndex];
    let endPart = 'end';
    let leadingCommentsOnEnd = '';

    if (endNode) {
        const innerIndentStr = indentChar.repeat(innerIndentLevel);
        leadingCommentsOnEnd = formatLeadingComments(endNode.leadingComments, innerIndentStr, context);

        const trailingCommentOnEnd = formatTrailingComments(endNode.trailingComments, context);
        if (trailingCommentOnEnd) {
            endPart += ' ' + trailingCommentOnEnd;
        }
    }
    
    if (leadingCommentsOnEnd) {
        content += '\n' + leadingCommentsOnEnd.trimEnd();
    }
    
    if (executableNodes.length > 0 && content.includes('\n')) {
         content += '\n' + baseIndent;
    } else if (!content.includes('\n') && content.trim() === 'begin') {
         content += ' ';
    }
   
    content += endPart;

    const trailingCommentOnBlock = formatTrailingComments(node.trailingComments, context);
    if (trailingCommentOnBlock) {
         content += ' ' + trailingCommentOnBlock;
    }

    return content;
}

function formatIfStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const ifIndentStr = style.isChainedIf ? '' : baseIndent;
    
    const ifNode = findChild(node, 'IF');
    if (!ifNode) return extractOriginalText(node, context.originalText).trim();

    const ifChildren = node.children || [];
    const conditionPartEndIndex = ifChildren.findIndex(c => c.name === 'RPAREN');
    if (conditionPartEndIndex === -1) return `${ifIndentStr}if (/* parse error */);`;

    const conditionPartNodes = ifChildren.slice(ifChildren.indexOf(ifNode), conditionPartEndIndex + 1);
    let content = ifIndentStr + reconstructExpressionText({ name: 'temp', children: conditionPartNodes }, context);

    const rParenNode = ifChildren[conditionPartEndIndex];
    if (rParenNode) {
        const trailingCommentOnCondition = formatTrailingComments(rParenNode.trailingComments, context);
        if (trailingCommentOnCondition) {
            content += ' ' + trailingCommentOnCondition;
        }
    }
    
    const elseTokenIndex = ifChildren.findIndex(c => c.name === 'ELSE');
    const thenClause = ifChildren[conditionPartEndIndex + 1];
    const elseClause = (elseTokenIndex !== -1) ? ifChildren[elseTokenIndex + 1] : undefined;

    if (thenClause && thenClause.name === 'statement') {
        const bodyContent = formatStatement(thenClause, config, indentLevel, context, { isKnrStyle: true });
        content += ' ' + bodyContent.trim();
    } else {
        content += ';';
    }
    
    if (elseClause && elseClause.name === 'statement') {
        const isElseIf = elseClause.children?.some(c => c.name === 'IF');
        content += `\n${baseIndent}else`;
        const elseNode = findChild(node,'ELSE');
        if(elseNode?.trailingComments){
            const trailingOnElse = formatTrailingComments(elseNode.trailingComments, context);
            if(trailingOnElse){
                content += " " + trailingOnElse;
            }
        }
        
        const bodyContent = formatStatement(elseClause, config, indentLevel, context, { isChainedIf: isElseIf, isKnrStyle: !isElseIf });
        content += ' ' + bodyContent.trim();
    }
    
    const trailingCommentOnIf = formatTrailingComments(node.trailingComments, context);
    if(trailingCommentOnIf){
        content += " " + trailingCommentOnIf;
    }

    return content;
}

function formatForStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    
    const forNode = findChild(node, 'FOR');
    if (!forNode) return extractOriginalText(node, context.originalText).trim();
    
    const forChildren = node.children || [];
    const rParenIndex = forChildren.findIndex(c => c.name === 'RPAREN');

    if (rParenIndex === -1) {
        return baseIndent + extractOriginalText(node, context.originalText).trim();
    }
    
    const headerNodes = forChildren.slice(forChildren.indexOf(forNode), rParenIndex + 1);
    let headerContent = baseIndent + reconstructExpressionText({ name: 'temp', children: headerNodes }, context);

    const rParenNode = forChildren[rParenIndex];
    if (rParenNode) {
        const trailingCommentOnHeader = formatTrailingComments(rParenNode.trailingComments, context);
        if(trailingCommentOnHeader) {
            headerContent += ' ' + trailingCommentOnHeader;
        }
    }

    const bodyStatementNode = forChildren[rParenIndex + 1];
    const bodyContent = formatStatement(bodyStatementNode, config, indentLevel, context, { isKnrStyle: true });
    
    let result = headerContent + ' ' + bodyContent.trim();
    
    const trailingCommentOnFor = formatTrailingComments(node.trailingComments, context);
    if(trailingCommentOnFor){
        result += " " + trailingCommentOnFor;
    }

    return result;
}

function formatRepeatStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);

    const repeatNode = findChild(node, 'REPEAT');
    if (!repeatNode) return extractOriginalText(node, context.originalText).trim();

    const children = node.children || [];
    const rParenIndex = children.findIndex(c => c.name === 'RPAREN');
    if (rParenIndex === -1) {
        return baseIndent + extractOriginalText(node, context.originalText).trim();
    }

    const headerNodes = children.slice(children.indexOf(repeatNode), rParenIndex + 1);
    let headerContent = baseIndent + reconstructExpressionText({ name: 'temp', children: headerNodes }, context);
    
    const rParenNode = children[rParenIndex];
    if (rParenNode) {
        const trailingComment = formatTrailingComments(rParenNode.trailingComments, context);
        if (trailingComment) {
            headerContent += ' ' + trailingComment;
        }
    }

    const bodyStatementNode = children[rParenIndex + 1];
    if (bodyStatementNode && bodyStatementNode.name === 'statement') {
        const bodyContent = formatStatement(bodyStatementNode, config, indentLevel, context, { isKnrStyle: true });
        return headerContent + ' ' + bodyContent.trim();
    }

    return headerContent + ';';
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

function formatInstantiationParameters(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const paramIndent = indentChar.repeat(indentLevel + 1);
    
    const listNode = findChild(node, 'list_of_param_assignments');
    if (!listNode || !listNode.children) return '#()';

    const paramAssignments = findAllChildren(listNode, 'named_parameter_assignment');
    if (paramAssignments.length === 0) return '#()';

    reassociateTrailingLineComments(paramAssignments);

    const inst_param_align_lparen = config.get<number>('inst_param_align_lparen', 40);
    const inst_param_align_rparen = config.get<number>('inst_param_align_rparen', 80);

    const resultLines: string[] = [];
    for (let i = 0; i < paramAssignments.length; i++) {
        const assign = paramAssignments[i];
        
        let currentLine = formatLeadingComments(assign.leadingComments, paramIndent, context).trimEnd();

        const paramName = getRawNodeText(findChild(assign, 'IDENTIFIER'));
        const paramValue = reconstructExpressionText(findChild(assign, 'primary'), context);
        
        let codePart = `${paramIndent}.${paramName}`;
        codePart += ' '.repeat(Math.max(1, inst_param_align_lparen - codePart.length)) + `(${paramValue}`;
        codePart += ' '.repeat(Math.max(1, inst_param_align_rparen - codePart.length - 1)) + ')';
        
        if(currentLine) currentLine += `\n${codePart}`;
        else currentLine = codePart;

        const isLast = i === paramAssignments.length - 1;
        currentLine += isLast ? '' : ',';
        
        const trailingCommentText = formatTrailingComments(assign.trailingComments, context);

        if (trailingCommentText) {
            currentLine += ' ' + trailingCommentText;
        }

        resultLines.push(currentLine.trimEnd());
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

    reassociateTrailingLineComments(portConnections);

    const inst_port_align_name = config.get<number>('inst_port_align_name', 24);
    const inst_port_align_lparen = config.get<number>('inst_port_align_lparen', 40);
    const inst_port_align_rparen = config.get<number>('inst_port_align_rparen', 80);

    const resultLines: string[] = [];
    for (let i = 0; i < portConnections.length; i++) {
        const conn = portConnections[i];
        
        let currentLine = formatLeadingComments(conn.leadingComments, portIndent, context).trimEnd();

        const portName = getRawNodeText(findChild(conn, 'IDENTIFIER'));
        const portSignal = reconstructExpressionText(findChild(conn, 'primary') || findChild(conn, 'logical_and_expression'), context);
        
        let codePart = `${portIndent}.${portName}`;
        codePart += ' '.repeat(Math.max(1, inst_port_align_name - codePart.length));
        codePart += ' '.repeat(Math.max(1, inst_port_align_lparen - codePart.length)) + `(${portSignal}`;
        codePart += ' '.repeat(Math.max(1, inst_port_align_rparen - codePart.length - 1)) + ')';

        if (currentLine) currentLine += `\n${codePart}`;
        else currentLine = codePart;

        const isLast = i === portConnections.length - 1;
        currentLine += isLast ? '' : ',';
        
        const trailingCommentText = formatTrailingComments(conn.trailingComments, context);
        if (trailingCommentText) {
            currentLine += ' ' + trailingCommentText;
        }
        
        resultLines.push(currentLine.trimEnd());
    }
    return `(\n${resultLines.join('\n')}\n${indent})`;
}

// =========================================================================
// REGEX-BASED FALLBACK MODE FUNCTIONS (COMPLETE AND UNABBREVIATED)
// =========================================================================
function alignVerilogCodeRegexOnly(text: string, config: vscode.WorkspaceConfiguration): string {
    const lines = text.split('\n');
    const alignedLines = lines.map(line => {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('/*') || trimmedLine.startsWith('//') || trimmedLine === '') return line;
      const isTwoDimArray = /^\s*(reg|wire)\s*(signed|unsigned)?\s*($$[^$$]+\])\s*[^;,\s]+\s*($$[^$$]+\])/.test(line);
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
    const regex = /^\s*(input\b|output\b|inout\b)\s*(reg|wire)?\s*(signed|unsigned)?\s*($$[^$$]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
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
    const regex = /^\s*(reg\b|wire\b|integer\b|real\b)\s*(signed|unsigned)?\s*($$[^$$]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
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
    const regex = /^\s*\.([^\s$]+)\s*\(([^)]*)$\s*([,])?\s*(.*)/;
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
    const regex = /^\s*(reg|wire)\s*(signed|unsigned)?\s*($$[^$$]+\])\s*([^;,\s]+\s*($$[^$$]+\]))\s*([;])?\s*(.*)/;
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
