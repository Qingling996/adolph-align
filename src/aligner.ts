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
        processedCommentIndices: new Set<number>()
    };
    return formatASTNode(astRootNode, config, 0, context).trim() + '\n';
}

function findChild(node: ASTNode, name: string): ASTNode | undefined {
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

function reconstructExpressionText(node: ASTNode | undefined): string {
    if (!node) return '';
    if (node.value !== undefined) return node.value;
    if (node.children) {
        return node.children.map(reconstructExpressionText).join(' ');
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
    let formatted = '';
    comments.forEach(comment => {
        if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
            formatted += comment.text;
            context.processedCommentIndices.add(comment.originalTokenIndex);
        }
    });
    return formatted.trim();
}

// =========================================================================
// PURE AST-DRIVEN FORMATTER (调度器)
// =========================================================================
function formatASTNode(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    if (!node || node.name === 'EOF') return '';

    const baseIndent = indentChar.repeat(indentLevel);
    
    switch (node.name) {
        case 'source_text':
            let result = formatLeadingComments(node.leadingComments, baseIndent, context);
            result += (node.children || []).map(child => formatASTNode(child, config, indentLevel, context)).join('');
            return result;

        case 'module_declaration':
            return formatModuleDeclaration(node, config, indentLevel, context);

        case 'module_item': {
            const firstChild = node.children?.[0];
            if (!firstChild) return '';

            let commentBearingNode = firstChild;
            if (commentBearingNode.name === 'signals_declaration' && commentBearingNode.children?.[0]) {
                commentBearingNode = commentBearingNode.children[0];
            }
            
            let leadingComments = formatLeadingComments(commentBearingNode.leadingComments, baseIndent, context);
            
            let itemContent;

            if (firstChild.name === 'always_construct') {
                itemContent = formatAlwaysConstruct(firstChild, config, indentLevel, context);
            } else if (firstChild.name === 'signals_declaration') {
                const codePart = formatASTNode(firstChild, config, 0, context);
                let line = baseIndent + codePart;

                const trailingComment = formatTrailingComments(node.trailingComments, context).trim();
                const alignColumn = config.get<number>('signal_num5', 80);
                const spaces = Math.max(1, alignColumn - line.length);
                
                line += ' '.repeat(spaces) + ';';

                if (trailingComment) {
                    line += ' ' + trailingComment;
                }
                itemContent = line + '\n';
            } else {
                let coreContent = (node.children || []).map(child => formatASTNode(child, config, 0, context)).join('');
                let line = baseIndent + coreContent;
                const trailingComment = formatTrailingComments(node.trailingComments, context).trim();
                if (trailingComment) {
                    line += ' ' + trailingComment;
                }
                itemContent = line + '\n';
            }
            return leadingComments + itemContent;
        }

        case 'signals_declaration':
            return formatSignalsDeclaration(node, config, context);

        case 'SEMI':
            return ';';

        default:
            return reconstructExpressionText(node);
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
  const trailingComment = formatTrailingComments(node.trailingComments, context);
  if (trailingComment) {
      content += ' ' + trailingComment;
  }
  return content;
}

function formatParameterPortList(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indent = indentChar.repeat(indentLevel);
    const paramIndentStr = indentChar.repeat(indentLevel + 1);
    let content = '#(\n';
    const assignments = findAllChildren(node, 'param_assignment');
    const param_num2 = config.get<number>('param_num2', 25);
    const param_num3 = config.get<number>('param_num3', 50);

    assignments.forEach((p, index) => {
        let line = formatLeadingComments(p.leadingComments, paramIndentStr, context);
        const keyword = getRawNodeText(findChild(p, 'PARAMETER'));
        const identifier = getRawNodeText(findChild(p, 'IDENTIFIER'));
        const value = reconstructExpressionText(findChild(p, 'constant_expression'));

        let currentLine = paramIndentStr + keyword;
        currentLine += ' '.repeat(Math.max(1, param_num2 - currentLine.length));
        currentLine += identifier;
        currentLine += ' '.repeat(Math.max(1, param_num3 - currentLine.length));
        currentLine += '= ' + value;

        if (index < assignments.length - 1) currentLine += ',';
        
        line += currentLine;
        const trailingComment = formatTrailingComments(p.trailingComments, context);
        if (trailingComment) {
          line += ' ' + trailingComment;
        }
        content += line + '\n';
    });
    content += indent + ')';
    return content;
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
            for (const comment of actualDecl.leadingComments) {
                if (!context.processedCommentIndices.has(comment.originalTokenIndex)) {
                     if (comment.text.startsWith('/*')) {
                        info.blockComments.push(comment);
                    } else if (comment.text.startsWith('//')) {
                        if (lineInfos.length > 0) {
                            lineInfos[lineInfos.length - 1].lineComment = comment.text;
                            context.processedCommentIndices.add(comment.originalTokenIndex);
                        }
                    }
                }
            }
        }
        if (actualDecl.trailingComments) {
            info.lineComment = formatTrailingComments(actualDecl.trailingComments, context);
        }
        lineInfos.push(info);
    }
    
    const resultLines: string[] = [];
    for (let i = 0; i < lineInfos.length; i++) {
        const info = lineInfos[i];
        
        if (info.blockComments.length > 0) {
            resultLines.push(formatLeadingComments(info.blockComments, portIndent, context).trimEnd());
        }

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

    return `${indent}(\n${resultLines.join('\n')}\n${indent})`;
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
    const widthPart = reconstructExpressionText(findChild(declaration, 'range_expression')) || '';
    const signalPart = getRawNodeText(findChild(declaration, 'IDENTIFIER'));
    
    const port_num2 = config.get<number>('port_num2', 16);
    const port_num3 = config.get<number>('port_num3', 25);
    const port_num4 = config.get<number>('port_num4', 50);

    const typeAndReg = [typePart, regKeywordPart].filter(Boolean).join(' ');
    
    let currentLine = indentStr + typeAndReg;
    currentLine += ' '.repeat(Math.max(1, port_num2 - (currentLine.length - indentStr.length)));
    currentLine += signedUnsignedPart;
    currentLine += ' '.repeat(Math.max(1, port_num3 - (currentLine.length - indentStr.length)));
    currentLine += widthPart;
    currentLine += ' '.repeat(Math.max(1, port_num4 - (currentLine.length - indentStr.length)));
    currentLine += signalPart;
    
    return currentLine;
}

function formatSignalsDeclaration(node: ASTNode, config: vscode.WorkspaceConfiguration, context: FormattingContext): string {
    const decl = node.children?.[0];
    if (!decl) return '';
    let type = '';
    if (decl.name === 'reg_declaration') type = 'reg';
    else if (decl.name === 'wire_declaration') type = 'wire';
    else if (decl.name === 'integer_declaration') type = 'integer';
    
    const signed = getRawNodeText(findChild(decl, 'SIGNED')) || '';
    const range = reconstructExpressionText(findChild(decl, 'range_expression')) || '';
    const identifier = getRawNodeText(findChild(decl, 'IDENTIFIER')) || '';
    
    const signal_num2 = config.get<number>('signal_num2', 16);
    const signal_num3 = config.get<number>('signal_num3', 25);
    const signal_num4 = config.get<number>('signal_num4', 50);
    
    let coreLine = type;
    coreLine += ' '.repeat(Math.max(1, signal_num2 - coreLine.length));
    coreLine += signed;
    coreLine += ' '.repeat(Math.max(1, signal_num3 - coreLine.length));
    coreLine += range;
    coreLine += ' '.repeat(Math.max(1, signal_num4 - coreLine.length));
    coreLine += identifier;
    
    return coreLine.trimEnd();
}

function formatAlwaysConstruct(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext): string {
    const indentStr = indentChar.repeat(indentLevel);
    const sensitivityList = reconstructExpressionText(findChild(node, 'event_control')).trim();
    let content = indentStr + 'always ' + sensitivityList + ' ';
    
    const statement = findChild(node, 'statement_or_null');
    if (statement) {
        content += formatStatement(statement, config, indentLevel, context, { isKnrStyle: true });
    }
    
    return content + '\n';
}

interface StatementStyle { isKnrStyle?: boolean; isChainedIf?: boolean; }

// **FIX for 1-1**: Modified to handle comments on wrapper nodes.
function formatStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    let unwrappedItem = node;
    while (unwrappedItem.children?.length === 1 && ['statement_or_null', 'statement'].includes(unwrappedItem.name)) {
        unwrappedItem = unwrappedItem.children[0];
    }

    let result = '';
    
    if (findChild(unwrappedItem, 'BEGIN')) {
        result = formatBeginEnd(unwrappedItem, config, indentLevel, context, style);
    } else if (findChild(unwrappedItem, 'IF')) {
        result = formatIfStatement(unwrappedItem, config, indentLevel, context, style);
    } else {
        const itemIndent = style.isChainedIf ? indentChar.repeat(indentLevel) : indentChar.repeat(indentLevel + 1);
        let coreContent = '';
        if (unwrappedItem.name === 'assignment_statement') {
            const lvalue = reconstructExpressionText(findChild(unwrappedItem, 'variable_lvalue'));
            const operator = getRawNodeText(findChild(unwrappedItem, 'LE_OP')) ? '<=' : '=';
            const expression = reconstructExpressionText(findChild(unwrappedItem, 'expression'));
            coreContent = itemIndent + lvalue + ' ' + operator + ' ' + expression + ' ;';
        } else {
             let defaultContent = reconstructExpressionText(unwrappedItem);
             if (!defaultContent.trim().endsWith(';')) defaultContent += ';';
             coreContent = itemIndent + defaultContent;
        }
        result = coreContent;
    }
    
    // Crucially, get comments from the original wrapper 'node', not the 'unwrappedItem'.
    const trailingComment = formatTrailingComments(node.trailingComments, context);
    if (trailingComment) {
      result += ' ' + trailingComment;
    }

    return result;
}

// **FIX for 1-1**: Corrected newline handling for proper 'end' alignment.
function formatBeginEnd(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle): string {
    const baseIndent = indentChar.repeat(indentLevel);
    let content = (style.isKnrStyle ? '' : baseIndent) + 'begin';
    
    const statementsInBlock = findAllChildren(node, 'statement');
    if (statementsInBlock.length > 0) {
        content += '\n';
        const statements = statementsInBlock.map(s => formatStatement(s, config, indentLevel, context));
        content += statements.join('\n');
        content += '\n' + baseIndent;
    }
    
    content += 'end';
    return content;
}

function formatIfStatement(node: ASTNode, config: vscode.WorkspaceConfiguration, indentLevel: number, context: FormattingContext, style: StatementStyle = {}): string {
    const baseIndent = indentChar.repeat(indentLevel);
    const ifIndentStr = style.isChainedIf ? '' : baseIndent;
    
    let content = ifIndentStr + 'if (' + reconstructExpressionText(findChild(node, 'expression')) + ') ';
    
    const [thenClause, elseClauseCandidate] = findAllChildren(node, 'statement_or_null');
    const elseToken = findChild(node, 'ELSE');
    
    if (thenClause) {
        content += formatStatement(thenClause, config, indentLevel, context, { isKnrStyle: true });
    }
    
    if (elseToken && elseClauseCandidate) {
        content += '\n' + baseIndent + 'else';
        let elseUnwrapped = elseClauseCandidate;
        while (elseUnwrapped.children?.length === 1 && ['statement_or_null', 'statement'].includes(elseUnwrapped.name)) {
            elseUnwrapped = elseUnwrapped.children[0];
        }
        const isChainedIf = findChild(elseUnwrapped, 'IF');
        if (isChainedIf) {
            content += ' ';
            content += formatStatement(elseClauseCandidate, config, indentLevel, context, { isChainedIf: true });
        } else {
            content += ' ';
            content += formatStatement(elseClauseCandidate, config, indentLevel, context, { isKnrStyle: true });
        }
    }
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
    coreLine = coreLine.padEnd(port_num2 - indent.length, ' ') + signedUnsigned;
    coreLine = coreLine.padEnd(port_num3 - indent.length, ' ') + alignedWidth;
    coreLine = coreLine.padEnd(port_num4 - indent.length, ' ') + signal;
    let finalLine = indent + coreLine;
    const endPart = endSymbol + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, port_num5 - finalLine.length);
        finalLine += ' '.repeat(spaces) + endPart;
    }
    return finalLine.trimEnd();
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
    let coreLine = type.padEnd(signal_num2, ' ');
    coreLine = (coreLine + signedUnsigned).padEnd(signal_num3, ' ');
    coreLine = (coreLine + alignedWidth).padEnd(signal_num4, ' ');
    coreLine += signal;
    let finalLine = indent + coreLine;
    const endPart = (endSymbol || ';') + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, signal_num5 - finalLine.length);
        finalLine += ' '.repeat(spaces) + endPart;
    }
    return finalLine.trimEnd();
}
function alignParamDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
    const param_num2 = config.get<number>('param_num2', 25);
    const param_num3 = config.get<number>('param_num3', 50);
    const param_num4 = config.get<number>('param_num4', 80);
    const regex = /^\s*(localparam\b|parameter\b)\s+([^\s=]+)\s*=\s*([^;,\/]+)\s*([;,])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const type = match[1].trim();
    const signal = match[2].trim();
    const value = match[3].trim();
    const endSymbol = (match[4] || '').trim();
    const comment = (match[5] || '').trim();
    let coreLine = type.padEnd(param_num2 - indent.length, ' ') + signal;
    coreLine = coreLine.padEnd(param_num3 - indent.length, ' ') + '= ' + value;
    let finalLine = indent + coreLine;
    const endPart = endSymbol + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, param_num4 - finalLine.length);
        finalLine += ' '.repeat(spaces) + endPart;
    }
    return finalLine.trimEnd();
}
function alignAssignDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
    const assign_num2 = config.get<number>('assign_num2', 12);
    const assign_num3 = config.get<number>('assign_num3', 30);
    const regex = /^\s*assign\b\s+([^\s=]+)\s*=\s*([^;]+)\s*([;])?\s*(.*)/;
    const match = line.match(regex);
    if (!match) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    const signal = match[1].trim();
    const value = match[2].trim();
    const endSymbol = (match[3] || '').trim();
    const comment = (match[4] || '').trim();
    let coreLine = 'assign'.padEnd(assign_num2 - indent.length, ' ') + signal;
    coreLine = coreLine.padEnd(assign_num3 - indent.length, ' ') + '= ' + value;
    let finalLine = indent + coreLine;
    const endPart = endSymbol + (comment ? ' ' + comment : '');
    finalLine += ' ' + endPart.trim();
    return finalLine.trimEnd();
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
    let coreLine = `.${signal}`.padEnd(inst_num2 - indent.length, ' ') + `(${connection})`;
    let finalLine = indent + coreLine;
    const endPart = endSymbol + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, inst_num3 - finalLine.length);
        finalLine += ' '.repeat(spaces) + endPart;
    }
    return finalLine.trimEnd();
}
function alignTwoDimArrayDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
    const array_num2 = config.get<number>('array_num2', 16);
    const array_num3 = config.get<number>('array_num3', 25);
    const array_num4 = config.get<number>('array_num4', 50);
    const array_num5 = config.get<number>('array_num5', 60);
    const array_num6 = config.get<number>('array_num6', 80);
    const regex = /^\s*(reg\b|wire\b)\s*(signed|unsigned)?\s*(\[[^\]]+\])\s*([^;,\s]+\s*(\[[^\]]+\]))\s*([;])?\s*(.*)/;
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
    let coreLine = type.padEnd(array_num2 - indent.length, ' ') + signedUnsigned;
    coreLine = coreLine.padEnd(array_num3 - indent.length, ' ') + alignedWidth1;
    coreLine = coreLine.padEnd(array_num4 - indent.length, ' ') + signal;
    coreLine = coreLine.padEnd(array_num5 - indent.length, ' ') + alignedWidth2;
    let finalLine = indent + coreLine;
    const endPart = endSymbol + (comment ? ' ' + comment : '');
    if (endPart.trim()){
        const spaces = Math.max(1, array_num6 - finalLine.length);
        finalLine += ' '.repeat(spaces) + endPart;
    }
    return finalLine.trimEnd();
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
