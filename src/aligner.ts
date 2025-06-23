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

    // 对于带有值的叶子节点，直接返回值
    if (node.value !== undefined) {
        // 对于操作符和关键字，我们不需要额外的空格处理，直接返回值
        // 对于标识符和数字，我们也直接返回值，空格由父节点处理
        return node.value;
    }

    // 对于没有值但有子节点的父节点，递归重组
    if (node.children && node.children.length > 0) {
        let result = '';
        // 定义哪些 token 前后不需要空格
        const noSpaceAfter = new Set(['[', '(', '`', '$', '.']);
        const noSpaceBefore = new Set(['[', ']', '(', ')', ',', ';', ':', '.']);
        
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            const currentTokenText = reconstructExpressionText(child, context);
            
            if (!currentTokenText) continue;

            if (result.length > 0) {
                const lastCharOfResult = result.charAt(result.length - 1);
                const firstCharOfCurrent = currentTokenText.charAt(0);
                
                // 决定是否在两个 token 之间加空格
                // 规则：除非前后 token 在 "no space" 集合中，否则就加空格
                if (!(noSpaceAfter.has(lastCharOfResult) || noSpaceBefore.has(firstCharOfCurrent))) {
                     // 特殊处理减号 '-'，如果它代表负数而不是减法操作符，则不加空格
                    if (currentTokenText === '-' && (noSpaceAfter.has(lastCharOfResult) || i === 0)) {
                         // 这很可能是一个负数，比如 `(-1)` 或 `[-1:0]`
                    } else {
                        result += ' ';
                    }
                }
            }
            result += currentTokenText;
        }
        return result;
    }
    
    // 如果节点既没有值也没有子节点，返回空字符串
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
                    alignConfigKey = 'param_num4';
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
    const localparam_num2 = config.get<number>('param_num2', 25);
    const localparam_num3 = config.get<number>('param_num3', 50);

    const keyword = getRawNodeText(findChild(decl, 'PARAMETER')) || getRawNodeText(findChild(decl, 'LOCALPARAM')) || 'parameter';

    // --- 核心修复：根据提供的 AST 结构进行精准查找 ---

    // 1. 获取标识符 (参数名)
    // 根据AST: decl -> variable_with_dimensions -> IDENTIFIER
    let identifier = '';
    const varWithDimNode = findChild(decl, 'variable_with_dimensions');
    if (varWithDimNode) {
        identifier = getRawNodeText(findChild(varWithDimNode, 'IDENTIFIER'));
    } else {
        // 作为备用方案，如果AST结构有变，尝试旧的查找方式
        identifier = getRawNodeText(findChild(decl, 'IDENTIFIER')) || 
                     reconstructExpressionText(findChild(decl, 'list_of_identifiers'), context);
    }

    // 2. 获取值
    // 根据AST: 值在 'primary' 或 'constant_expression' 节点中
    const valueNode = findChild(decl, 'primary') || findChild(decl, 'constant_expression');
    const value = valueNode ? reconstructExpressionText(valueNode, context) : '';
    
    // --- 修复结束 ---
    
    let currentLine = indentStr + keyword;
    currentLine += ' '.repeat(Math.max(1, localparam_num2 - currentLine.length)) + identifier;

    // 只有在成功提取到值的情况下才添加 '=' 和值
    if (value) {
        currentLine += ' '.repeat(Math.max(1, localparam_num3 - currentLine.length)) + '= ' + value;
    }
    
    return currentLine;
}

function formatSignalsDeclarationCode(decl: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    
    // 提取通用部分
    let type = '';
    if (decl.name === 'reg_declaration') type = 'reg';
    else if (decl.name === 'wire_declaration') type = 'wire';
    else if (decl.name === 'integer_declaration') type = 'integer';
    else if (decl.name === 'real_declaration') type = 'real';
    
    const signed = getRawNodeText(findChild(decl, 'SIGNED')) || '';
    
    // 第一个维度（类型后的维度）
    const firstRangeNode = findChild(decl, 'range_expression');
    const firstRange = firstRangeNode ? `[${reconstructExpressionText(firstRangeNode, context).replace(/\[|\]/g, '')}]` : '';

    // 提取标识符和第二个维度
    let identifier = '';
    let secondRange = '';
    const varWithDimNode = findChild(decl, 'variable_with_dimensions');
    if (varWithDimNode) {
        // 二维数组或带维度的单维数组
        identifier = getRawNodeText(findChild(varWithDimNode, 'IDENTIFIER')) || '';
        const secondRangeNode = findChild(varWithDimNode, 'range_expression');
        secondRange = secondRangeNode ? `[${reconstructExpressionText(secondRangeNode, context).replace(/\[|\]/g, '')}]` : '';
    } else {
        // 普通信号（可能是列表）
        const idListNode = findChild(decl, 'list_of_identifiers') || findChild(decl, 'variable_lvalue');
        identifier = idListNode ? reconstructExpressionText(idListNode, context) : '';
    }

    // 获取对齐配置
    const signal_num2 = config.get<number>('signal_num2', 16);
    const signal_num3 = config.get<number>('signal_num3', 25);
    const signal_num4 = config.get<number>('signal_num4', 50);
    // 新增一个配置项用于二维数组第二维度的对齐
    // const signal_num5_array_dim = config.get<number>('signal_num5', 60);

    // 拼接代码行
    let currentLine = indentStr + type;
    currentLine += ' '.repeat(Math.max(1, signal_num2 - currentLine.length)) + signed;
    currentLine += ' '.repeat(Math.max(1, signal_num3 - currentLine.length)) + firstRange;
    currentLine += ' '.repeat(Math.max(1, signal_num4 - currentLine.length)) + identifier;
    
    // 如果有第二维度，则添加并对齐
    if (secondRange) {
        // currentLine += ' '.repeat(Math.max(1, signal_num5_array_dim - currentLine.length)) + secondRange;
        currentLine += ' '.repeat(1) + secondRange;//考虑后排空格跟随
    }

    return currentLine;
}

function formatContinuousAssignCode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const assign_num2 = config.get<number>('assign_num2', 20);
    const assign_num3 = config.get<number>('assign_num3', 50);
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
    let content = '\n' + baseIndent + 'always';
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
        // --- 核心修复 ---
        // 直接处理这个特殊的节点，不再通过 formatExecutableNode
        bodyContent = formatSimpleStatement(procTimeControlNode, config, indentLevel, context).trim();
        if (!bodyContent.endsWith(';')) {
            bodyContent += ';';
        }
        // 从 bodyContent 中移除缩进，因为 'always' 已经带了缩进
        bodyContent = bodyContent.trim();
        // --- 修复结束 ---
    } else if (statementNode) {
        bodyContent = formatStatement(statementNode, config, indentLevel, context, { isKnrStyle: true });
    }

    if (bodyContent.trim()) {
        // 移除 bodyContent 可能带有的前导缩进
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
            // 确保简单语句也总是带分号返回
            codeContent = formatSimpleStatement(node, config, indentLevel, context);
            if (!codeContent.trim().endsWith(';')) {
                const trailingCommentOnNode = collectAllTrailingComments(node, context);
                if (trailingCommentOnNode) {
                    const commentAlign = config.get<number>('always_comment_align', 80);
                    codeContent += ' '.repeat(Math.max(1, commentAlign - codeContent.length)) + '; ' + trailingCommentOnNode;
                } else {
                    codeContent += ';';
                }
            }
            break;
        default:
            // Fallback
            codeContent = itemIndent + extractOriginalText(node, context.originalText).trim();
            break;
    }
    
    return (leadingComments + codeContent).trimEnd();
}

function formatStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const itemIndent = indentChar.repeat(indentLevel);
    const firstSemanticChild = node.children?.find(c => c.name && c.name !== 'SEMI');

    if (!firstSemanticChild) {
        const trailingComment = formatTrailingComments(findChild(node, 'SEMI')?.trailingComments, context);
        return ((style.isChainedIf ? '' : itemIndent) + ';' + (trailingComment ? ' ' + trailingComment : '')).trimEnd();
    }
    
    let codePart = '';
    
    switch (firstSemanticChild.name) {
        case 'BEGIN':
            return formatBeginEnd(node, config, indentLevel, context, style);
        case 'IF':
            return formatIfStatement(node, config, indentLevel, context, style);
        // ============= NEWLY ADDED CASE =============
        case 'CASE':
            return formatCaseStatement(node, config, indentLevel, context, style);
        // ============================================
        case 'FOR':
            return formatForStatement(node, config, indentLevel, context, style);
        case 'REPEAT':
            return formatRepeatStatement(node, config, indentLevel, context, style);
        
        case 'blocking_or_nonblocking_assignment':
            codePart = formatAssignmentStatement(firstSemanticChild, config, indentLevel, context);
            break;
        
        default:
            codePart = formatSimpleStatement(node, config, indentLevel, context);
            // 对于simpleStatement，它可能已经包含了分号，也可能没有，我们需要统一处理
            if (codePart.trim().endsWith(';')) {
                codePart = codePart.trim().slice(0, -1).trimEnd();
            }
            break;
    }

    // 1. 先拼接代码和分号
    let finalLine = codePart + ';';

    // 2. 然后处理所有的行尾注释 (从 statement 节点和 SEMI 节点收集)
    const trailingCommentOnNode = formatTrailingComments(node.trailingComments, context);
    const semiNode = findChild(node, 'SEMI');
    const semiTrailingComment = semiNode ? formatTrailingComments(semiNode.trailingComments, context) : '';
    const finalComment = [trailingCommentOnNode, semiTrailingComment].filter(Boolean).join(' ').trim();

    // 3. 如果有注释，就进行对齐拼接
    if (finalComment) {
        const commentAlign = config.get<number>('always_comment_align', 80);
        // 注意：这里我们是对 `finalLine` (已包含分号) 进行填充
        finalLine += ' '.repeat(Math.max(1, commentAlign - finalLine.length)) + finalComment;
    }

    return finalLine;
}

function formatAssignmentStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const itemIndent = indentChar.repeat(indentLevel);
    const always_lvalue_align = config.get<number>('always_lvalue_align', 28);
    const op_align = config.get<number>('always_op_align', 32);

    const lvalueNode = findChild(node, 'variable_lvalue') || findChild(node, 'net_lvalue');
    const opNode = findChild(node, 'LE_OP') || findChild(node, 'ASSIGN_EQ');
    const rvalueNode = node.children?.find(c => c.name.endsWith('expression') || c.name === 'primary' || c.name === 'concatenation' || c.name === 'system_task_call');
    
    // --- 核心修复：处理 lvalue 和 rvalue 上的前导注释 ---
    
    let codePart = '';
    if (lvalueNode && opNode && rvalueNode) {
        // 1. 格式化 lvalue 节点的前导注释
        const leadingCommentsOnLValue = formatLeadingComments(lvalueNode.leadingComments, itemIndent, context);
        if(leadingCommentsOnLValue) {
            codePart += leadingCommentsOnLValue;
        }

        const lvalue = reconstructExpressionText(lvalueNode, context);
        const op = opNode.value || '<=';

        // 2. 格式化 rvalue 节点的前导注释
        //    (虽然不常见，但为了健壮性也处理一下)
        const leadingCommentsOnRValue = formatLeadingComments(rvalueNode.leadingComments, ' ', context); // rvalue前不加额外缩进
        
        const rvalue = (leadingCommentsOnRValue ? leadingCommentsOnRValue.trim() + ' ' : '') + reconstructExpressionText(rvalueNode, context);
        
        let line = itemIndent + lvalue;
        line += ' '.repeat(Math.max(1, always_lvalue_align - line.length)) + op;
        line += ' '.repeat(Math.max(1, op_align - line.length)) + rvalue;
        
        // 如果 lvalue 有前导注释，它们已经被加到 codePart 里了，所以这里要追加
        codePart += line;

    } else {
        // Fallback
        codePart = `${itemIndent}${extractOriginalText(node, context.originalText).trim()}`;
    }

    return codePart;
}

function formatSimpleStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const itemIndent = indentChar.repeat(indentLevel);
    // 使用 reconstructExpressionText 替代 extractOriginalText，以获得更纯净的代码部分
    const statementText = reconstructExpressionText(node, context).trim();

    // 移除可能存在的尾部分号，让上层统一处理
    if (statementText.endsWith(';')) {
        return itemIndent + statementText.slice(0, -1).trimEnd();
    }
    return itemIndent + statementText;
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

function formatCaseStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    
    const caseNode = findChild(node, 'CASE');
    if (!caseNode) return extractOriginalText(node, context.originalText).trim();

    const children = node.children || [];
    const rParenIndex = children.findIndex(c => c.name === 'RPAREN');
    if (rParenIndex === -1) {
        return baseIndent + extractOriginalText(node, context.originalText).trim(); // Fallback for parse error
    }

    // 1. Format "case (...)" header
    const headerNodes = children.slice(children.findIndex(c => c.name === 'CASE'), rParenIndex + 1);
    let content = baseIndent + reconstructExpressionText({ name: 'temp', children: headerNodes }, context);
    
    const rParenNode = children[rParenIndex];
    if (rParenNode) {
        const trailingCommentOnHeader = formatTrailingComments(rParenNode.trailingComments, context);
        if (trailingCommentOnHeader) {
            content += ' ' + trailingCommentOnHeader;
        }
    }
    
    // 2. Format all case items
    const caseItems = findAllChildren(node, 'case_item');
    const caseItemIndentStr = indentChar.repeat(indentLevel + 1);
    // Calculate the absolute column for the colon, based on config and current indent level
    const colonAlignCol = config.get<number>('case_colon_align', 20) + caseItemIndentStr.length;

    const formattedItems = caseItems.map(item => {
        const leadingComments = formatLeadingComments(item.leadingComments, caseItemIndentStr, context);
        
        // a. Extract conditions (e.g., "1, 2, 3" or "default")
        const itemChildren = item.children || [];
        const colonIndex = itemChildren.findIndex(c => c.name === 'COLON');
        if (colonIndex === -1) return (leadingComments + caseItemIndentStr + "/* parse error */:").trimEnd();
        
        const conditionNodes = itemChildren.slice(0, colonIndex);
        const conditionStr = reconstructExpressionText({ name: 'temp', children: conditionNodes }, context);
        
        // b. Align the colon
        let itemLine = caseItemIndentStr + conditionStr;
        itemLine += ' '.repeat(Math.max(1, colonAlignCol - itemLine.length)) + ':';
        
        // c. Format the statement after the colon
        const statementNode = itemChildren[colonIndex + 1];
        if (statementNode) {
            if (statementNode.name === 'statement_or_null' && findChild(statementNode, 'SEMI')) {
                // Handle null statement like "default: ;"
                 itemLine += ';';
                 const trailingOnSemi = formatTrailingComments(findChild(statementNode, 'SEMI')?.trailingComments, context);
                 if (trailingOnSemi) itemLine += ' ' + trailingOnSemi;
            } else if (statementNode.name === 'statement') {
                // Recursively format the statement body. isKnrStyle=true keeps `begin` on the same line.
                const bodyContent = formatStatement(statementNode, config, indentLevel + 1, context, { isKnrStyle: true });
                itemLine += ' ' + bodyContent.trim();
            } else {
                 // Fallback for unexpected node types
                 itemLine += ' ' + extractOriginalText(statementNode, context.originalText).trim();
            }
        }
        
        const trailingCommentOnItem = formatTrailingComments(item.trailingComments, context);
        if (trailingCommentOnItem) {
             itemLine += ' ' + trailingCommentOnItem;
        }

        return (leadingComments + itemLine).trimEnd();

    }).join('\n');

    content += '\n' + formattedItems;

    // 3. Format "endcase"
    const endcaseNode = findChild(node, 'ENDCASE');
    if (endcaseNode) {
        const leadingComments = formatLeadingComments(endcaseNode.leadingComments, baseIndent, context);
        if (leadingComments) {
            content += '\n' + leadingComments.trimEnd();
        }
        
        let endcaseLine = baseIndent + 'endcase';
        const trailingComment = formatTrailingComments(endcaseNode.trailingComments, context);
        if (trailingComment) {
            endcaseLine += ' ' + trailingComment;
        }
        content += '\n' + endcaseLine;
    }
    
    return content;
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

    const inst_param_align_lparen = config.get<number>('inst_num2', 40);
    const inst_param_align_rparen = config.get<number>('inst_num3', 80);

    const resultLines: string[] = [];
    for (let i = 0; i < paramAssignments.length; i++) {
        const assign = paramAssignments[i];
        
        let currentLine = formatLeadingComments(assign.leadingComments, paramIndent, context).trimEnd();

        const paramName = getRawNodeText(findChild(assign, 'IDENTIFIER'));
        const paramValue = reconstructExpressionText(findChild(assign, 'primary'), context);
        
        let codePart = `${paramIndent}.${paramName}`;
        codePart += ' '.repeat(Math.max(1, inst_param_align_lparen - codePart.length)) + `(${paramValue}`;
        codePart += ' '.repeat(Math.max(1, inst_param_align_rparen - codePart.length)) + ')';
        
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

    const inst_port_align_name   = config.get<number>('inst_num1', 24);
    const inst_port_align_lparen = config.get<number>('inst_num2', 40);
    const inst_port_align_rparen = config.get<number>('inst_num3', 80);

    const resultLines: string[] = [];
    for (let i = 0; i < portConnections.length; i++) {
        const conn = portConnections[i];
        
        let currentLine = formatLeadingComments(conn.leadingComments, portIndent, context).trimEnd();

        const portName = getRawNodeText(findChild(conn, 'IDENTIFIER'));
        const portSignal = reconstructExpressionText(findChild(conn, 'primary') || findChild(conn, 'logical_and_expression'), context);
        
        let codePart = `${portIndent}.${portName}`;
        codePart += ' '.repeat(Math.max(1, inst_port_align_name - codePart.length));
        codePart += ' '.repeat(Math.max(1, inst_port_align_lparen - codePart.length)) + `(${portSignal}`;
        codePart += ' '.repeat(Math.max(1, inst_port_align_rparen - codePart.length)) + ')';

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
// REGEX-BASED FALLBACK MODE FUNCTIONS (COMPLETE AND ENHANCED)
// =========================================================================

// --- Types for Parsed Line Data ---
interface ParsedLine {
    indent: string;
    content: any;
    comment: string;
    originalLine: string;
}

interface DeclarationContent {
    type: string;
    signed: string;
    width1: string;
    signal: string;
    width2: string; // For 2D arrays
    value?: string;
    operator?: string;
    endSymbol: string;
}

// --- Main Dispatcher for Regex Mode ---
function alignVerilogCodeRegexOnly(text: string, config: vscode.WorkspaceConfiguration): string {
    const lines = text.split('\n');
    const newLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmedLine = line.trim();

        // 检查当前行是否是一个我们支持对齐的块的开始
        const blockType = getDeclarationBlockType(trimmedLine);
        
        // 只对 module 内部的、可识别的声明块进行处理
        if (blockType) {
            const blockLines: string[] = [];
            let j = i;
            
            // 收集所有连续的、同类型的行
            while (j < lines.length && getDeclarationBlockType(lines[j].trim()) === blockType) {
                blockLines.push(lines[j]);
                j++;
            }
            
            // 对收集到的块进行格式化
            const formattedBlock = processDeclarationBlock(blockLines, blockType, config);
            newLines.push(...formattedBlock);
            
            // 将主循环的索引快进到已处理块的末尾
            i = j;
        } else {
            // 如果不是可对齐的块，则原样保留该行
            newLines.push(line);
            i++;
        }
    }
    
    // 使用 join('\n') 来重建文本，这可以确保即使最后一行是空行也能被正确保留
    return newLines.join('\n');
}

// --- Block Processing Logic ---

function getDeclarationBlockType(trimmedLine: string): string | null {
    if (trimmedLine.startsWith('input') || trimmedLine.startsWith('output') || trimmedLine.startsWith('inout')) return 'port';
    // 关键修复：确保 reg/wire 出现在行首，且后面没有'@'符号
    if (trimmedLine.match(/^(reg|wire|integer|real)\b/) && !trimmedLine.includes('@')) return 'signal';
    if (trimmedLine.startsWith('localparam') || trimmedLine.startsWith('parameter')) return 'param';
    if (trimmedLine.startsWith('assign')) return 'assign';
    // 实例化的 .port(signal) 格式
    if (trimmedLine.match(/^\s*\./)) return 'instance';
    return null;
}

function processDeclarationBlock(blockLines: string[], type: string, config: vscode.WorkspaceConfiguration): string[] {
    try {
        const parsedLines: ParsedLine[] = [];
        const maxWidths: { [key: string]: number } = {};

        // 1. Parse all lines and find max widths
        for (const line of blockLines) {
            const parsed = parseLine(line, type, config);
            if(parsed) {
                parsedLines.push(parsed);
                // Dynamically update max widths based on content
                Object.keys(parsed.content).forEach(key => {
                    const value = parsed.content[key] || '';
                    maxWidths[key] = Math.max(maxWidths[key] || 0, value.length);
                });
            } else {
                 // If a line in the block fails to parse, add it as-is.
                parsedLines.push({indent: line.match(/^\s*/)?.[0] || '', content: null, comment: '', originalLine: line });
            }
        }

        // 2. Rebuild all lines with calculated alignment
        return parsedLines.map(p => {
            if (!p.content) return p.originalLine; // Return un-parsable line as is
            return rebuildLine(p, type, config, maxWidths);
        });

    } catch (e) {
        // If anything goes wrong during block processing, return the original block.
        console.error(`[Regex Aligner] Error processing block of type '${type}':`, e);
        return blockLines;
    }
}


// --- Line Parser Functions ---

function parseLine(line: string, type: string, config: vscode.WorkspaceConfiguration): ParsedLine | null {
    const indent = line.match(/^\s*/)?.[0] || '';
    const trimmedLine = line.trim();
    
    // Universal regex to separate code from comment
    const commentRegex = /^(.*?)\s*(\/\/.*|\/\*.*\*\/)?\s*$/;
    const commentMatch = trimmedLine.match(commentRegex);
    const codePart = (commentMatch?.[1] || '').trim();
    const comment = (commentMatch?.[2] || '').trim();

    let content: DeclarationContent | null = null;
    switch(type) {
        case 'port': content = parsePortOrSignal(codePart, config); break;
        case 'signal': content = parsePortOrSignal(codePart, config); break;
        case 'param': content = parseParam(codePart, config); break;
        case 'assign': content = parseAssign(codePart, config); break;
        case 'instance': content = parseInstance(codePart, config); break;
    }
    
    if (content) {
        return { indent, content, comment, originalLine: line };
    }
    return null;
}

function parsePortOrSignal(code: string, config: vscode.WorkspaceConfiguration): DeclarationContent | null {
    // This regex is more robust: handles optional 'reg'/'wire', 'signed', and dimensions.
    const regex = /^(inout|input|output|reg|wire|integer|real)?\s*(reg|wire)?\s*(signed)?\s*(\[[^\]]+\])?\s*([a-zA-Z0-9_$,\s]+?)\s*(\[[^\]]+\])?\s*([;,])?$/;
    const match = code.match(regex);
    if (!match) return null;
    
    const type = [match[1], match[2]].filter(Boolean).join(' ');
    const signed = match[3] || '';
    const width1 = match[4] || '';
    const signal = (match[5] || '').trim(); // Can be a list like "a, b, c"
    const width2 = match[6] || '';
    const endSymbol = match[7] || '';

    return { type, signed, width1: alignBitWidthDeclarationRegex(width1, config), signal, width2: alignBitWidthDeclarationRegex(width2, config), endSymbol };
}

function parseParam(code: string, config: vscode.WorkspaceConfiguration): DeclarationContent | null {
    const regex = /^(localparam|parameter)\s+([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*([;,])?$/;
    const match = code.match(regex);
    if (!match) return null;
    
    return { type: match[1], signal: match[2], operator: '=', value: match[3].trim(), endSymbol: match[4] || '', signed: '', width1: '', width2: '' };
}

function parseAssign(code: string, config: vscode.WorkspaceConfiguration): DeclarationContent | null {
    const regex = /^assign\s+([^\s=]+)\s*=\s*(.+?)\s*([;])?$/;
    const match = code.match(regex);
    if (!match) return null;

    return { type: 'assign', signal: match[1], operator: '=', value: match[2].trim(), endSymbol: match[3] || '', signed: '', width1: '', width2: '' };
}

function parseInstance(code: string, config: vscode.WorkspaceConfiguration): DeclarationContent | null {
    // Improved regex to handle various connections.
    const regex = /^\.\s*([a-zA-Z0-9_]+)\s*\((.*?)\)\s*([,])?$/;
    const match = code.match(regex);
    if (!match) return null;

    // Here, we use 'signal' for port name and 'value' for connection
    return { type: '.', signal: match[1], value: match[2].trim(), endSymbol: match[3] || '', signed: '', width1: '', operator: '', width2: '' };
}


// --- Line Rebuilder Functions ---

function rebuildLine(parsed: ParsedLine, type: string, config: vscode.WorkspaceConfiguration, maxWidths: { [key: string]: number }): string {
    const content = parsed.content as DeclarationContent;
    
    const fallbackIndentSize = config.get<number>('fallbackIndentSize', 4);
    const baseIndent = ' '.repeat(fallbackIndentSize);
    let line = baseIndent;

    switch(type) {
        case 'port':
        case 'signal':
            // 获取各部分的对齐列号
            const signal_num2 = config.get<number>('signal_num2', 16);
            const signal_num3 = config.get<number>('signal_num3', 25);
            const signal_num4 = config.get<number>('signal_num4', 50);
            
            // 拼接 type, signed, width1, 和 signal，并进行列对齐
            line += (content.type || '').padEnd(maxWidths.type);
            line += ' '.repeat(Math.max(1, signal_num2 - line.length)) + (content.signed || '').padEnd(maxWidths.signed);
            line += ' '.repeat(Math.max(1, signal_num3 - line.length)) + (content.width1 || '').padEnd(maxWidths.width1);
            line += ' '.repeat(Math.max(1, signal_num4 - line.length)) + (content.signal || '').padEnd(maxWidths.signal);
            
            // ==================== 核心修改点 ====================
            // 判断是否存在第二个维度 (width2)
            if (content.width2) {
                // 如果是二维数组，则第二个维度紧跟在信号名后，只空一格
                line = line.trimEnd(); // 先移除信号名 padEnd 产生的多余空格
                line += ' ' + content.width2;
            }
            // 如果不是二维数组，则什么都不做，保持之前的对齐即可。
            // =====================================================
            break;

        case 'param':
            const localparam_num2 = config.get<number>('param_num2', 25);
            const localparam_num3 = config.get<number>('param_num3', 50);

            line += (content.type || '').padEnd(maxWidths.type);
            line += ' '.repeat(Math.max(1, localparam_num2 - line.length)) + (content.signal || '').padEnd(maxWidths.signal);
            line += ' '.repeat(Math.max(1, localparam_num3 - line.length)) + `${content.operator} ${content.value}`;
            break;
            
        case 'assign':
            const assign_num2 = config.get<number>('assign_num2', 12);
            const assign_num3 = config.get<number>('assign_num3', 30);
            
            line += (content.type || '').padEnd(maxWidths.type);
            line += ' '.repeat(Math.max(1, assign_num2 - line.length)) + (content.signal || '').padEnd(maxWidths.signal);
            line += ' '.repeat(Math.max(1, assign_num3 - line.length)) + `${content.operator} ${content.value}`;
            break;
            
        case 'instance':
            const inst_port_align_lparen = config.get<number>('inst_num2', 40);
            
            line += `${content.type || '.'}${(content.signal || '').padEnd(maxWidths.signal)}`;
            line += ' '.repeat(Math.max(1, inst_port_align_lparen - line.length)) + `(${(content.value || '')})`;
            break;
    }

    line = line.trimEnd();

    // 对齐结束符和注释 (逻辑保持不变)
    let endSymbol = '';
    if (content.endSymbol) {
        endSymbol = content.endSymbol;
    } else if (type !== 'instance') {
        endSymbol = ';';
    }

    if (!endSymbol) {
        if (parsed.comment) {
             const commentAlignCol = config.get<number>('inst_num3', 80);
             line += ' '.repeat(Math.max(1, commentAlignCol - line.length)) + parsed.comment;
        }
        return line.trimEnd();
    }
    
    const endSymbolAlignCol = config.get<number>('inst_num3', 80);
    line += ' '.repeat(Math.max(1, endSymbolAlignCol - line.length));
    line += endSymbol;

    if (parsed.comment) {
        line += ' ' + parsed.comment;
    }
    
    return line.trimEnd();
}

// --- Helper for bit width formatting ---
function alignBitWidthDeclarationRegex(bitwidth: string, config: vscode.WorkspaceConfiguration): string {
    if (!bitwidth) return '';
    const content = bitwidth.slice(1, -1); // Remove brackets
    
    const upbound = config.get<number>('upbound', 2);
    const lowbound = config.get<number>('lowbound', 2);
    
    if (!content.includes(':')) return bitwidth;

    const parts = content.split(':');
    const up = parts[0].trim();
    const low = parts[1].trim();

    const alignedUp = up.padStart(Math.max(upbound, up.length), ' ');
    const alignedLow = low.padEnd(Math.max(lowbound, low.length), ' ');

    return `[${alignedUp}:${alignedLow}]`;
}
