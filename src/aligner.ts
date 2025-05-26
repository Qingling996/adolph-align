import * as vscode from 'vscode';
import { WorkspaceConfiguration } from 'vscode';

/**
 * 对齐 Verilog 代码
 * @param text - 输入的文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
export function alignVerilogCode(text: string, config: vscode.WorkspaceConfiguration): string {
  const lines = text.split('\n');
  const alignedLines = lines.map(line => {
    // 如果是注释行或空行，直接返回
    if (line.trim().startsWith('/*') || line.trim().startsWith('//') || line.trim() === '') {
      return line;
    }

    // 过滤掉模块声明、函数定义、always块等非目标内容
    // 注意：begin/end 等结构块也通常不对齐其内部，所以保留过滤
    if (
      line.trim().startsWith('module') ||
      line.trim().startsWith('function') ||
      line.trim().startsWith('always') ||
      line.trim().startsWith('initial') || // 增加 initial
      line.trim().startsWith('task') || // 增加 task
      line.trim().startsWith('endmodule') ||
      line.trim().startsWith('endfunction') ||
      line.trim().startsWith('endtask') || // 增加 endtask
      line.trim().startsWith('endalways') || // 增加 endalways (虽然不常见)
      line.trim().startsWith('endinitial') || // 增加 endinitial (虽然不常见)
      line.trim().startsWith('begin') ||
      line.trim().startsWith('end') ||
      line.trim().startsWith('if') || // 增加 if/else/case 等控制流
      line.trim().startsWith('else') ||
      line.trim().startsWith('case') ||
      line.trim().startsWith('endcase') ||
      line.trim().startsWith('for') ||
      line.trim().startsWith('while') ||
      line.trim().startsWith('repeat') ||
      line.trim().startsWith('fork') || // 增加 fork/join
      line.trim().startsWith('join')
    ) {
      return line;
    }

    // **新的优先级判断逻辑**
    // 先检查最具体的模式，然后是较通用的模式

    // 1. 二维数组声明 (最具体)
    const isTwoDimArray = /^\s*(reg|wire)\s*(signed|unsigned)?\s*\[[^\]]+\]\s*[^;,\s]+\s*\[[^\]]+\]/.test(line);
    if (isTwoDimArray) {
        return alignTwoDimArrayDeclaration(line, config);
    }

    // 2. 端口声明 (input/output/inout)
    if (line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) {
        return alignPortDeclaration(line, config);
    }

    // 3. 变量声明 (reg/wire/integer/real - 一维或无位宽)
    if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer') || line.trim().startsWith('real')) {
        // 如果不是二维数组，则按一维或无位宽处理
        return alignRegWireIntegerDeclaration(line, config);
    }

    // 4. 参数声明 (localparam/parameter)
    if (line.trim().startsWith('localparam') || line.trim().startsWith('parameter')) {
        return alignParamDeclaration(line, config);
    }

    // 5. assign 声明
    if (line.trim().startsWith('assign')) {
        return alignAssignDeclaration(line, config);
    }

    // 6. 实例化信号
    if (line.trim().startsWith('.')) {
        return alignInstanceSignal(line, config);
    }

    // 如果以上都不匹配，返回原行
    return line;
  });
  return alignedLines.join('\n');
}

/**
 * 对齐端口声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
    output reg  signed   [g_WORD_SIZE-1: 0]      Z                                       ,
 */
function alignPortDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const port_num1 = config.get<number>('port_num1', 4 ); // 行首到 input/output/inout 左侧的距离
  const port_num2 = config.get<number>('port_num2', 16); // 行首到 signed/unsigned 左侧的距离
  const port_num3 = config.get<number>('port_num3', 25); // 行首到位宽 "[" 左侧的距离
  const port_num4 = config.get<number>('port_num4', 50); // 行首到信号左侧的距离
  const port_num5 = config.get<number>('port_num5', 80); // 行首到 ",/;" 的长度

  // 改进的正则表达式：支持 input/output/inout，以及 signed/unsigned, 位宽是可选的
  const regex = /^\s*(input\b|output\b|inout\b)\s*(reg|wire)?\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line; // 应该能匹配到，因为已经在 alignVerilogCode 中判断过了

  const type            = match[1].trim();          // 类型：input/output/inout
  const regKeyword      = (match[2] || '').trim();  // reg/wire 关键字
  const signedUnsigned  = (match[3] || '').trim();  // signed/unsigned
  const width           = (match[4] || '').trim();  // 位宽声明字符串 (如 [31:0])
  const signal          = match[5].trim();          // 信号名称
  const endSymbol       = (match[6] || '').trim();  // 逗号或分号
  const comment         = (match[7] || '').trim();  // 注释内容

  // **内部处理位宽对齐**
  const alignedWidth = width ? alignBitWidthDeclaration(width, config) : '';

  // 对齐逻辑 - 基于长度计算填充空格
  let currentPos = 0;
  const parts: string[] = [];

  // 1. 对齐 type
  const typeSpaces = Math.max(0, port_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  // 2. 对齐 reg/wire (如果存在，紧跟在 type 后面，留一格空格)
  if (regKeyword) {
      parts.push(' ' + regKeyword);
      currentPos += 1 + regKeyword.length;
  }

  // 3. 对齐 signed/unsigned
  const signedSpaces = Math.max(0, port_num2 - currentPos);
  if (signedUnsigned) {
      parts.push(' '.repeat(signedSpaces) + signedUnsigned);
      currentPos += signedSpaces + signedUnsigned.length;
  }

  // 4. 对齐位宽声明
  const widthSpaces = Math.max(0, port_num3 - currentPos);
  if (alignedWidth) { // 使用内部对齐后的位宽
      parts.push(' '.repeat(widthSpaces) + alignedWidth);
      currentPos += widthSpaces + alignedWidth.length;
  }

  // 5. 对齐信号名称
  const signalSpaces = Math.max(0, port_num4 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  // 6. 对齐分号或逗号以及注释
  const endSymbolAndCommentSpaces = Math.max(0, port_num5 - currentPos);
  parts.push(' '.repeat(endSymbolAndCommentSpaces) + endSymbol + comment);

  return parts.join('');
}

/**
 * 对齐变量声明 (reg/wire/integer/real - 一维或无位宽)
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
*/
function alignRegWireIntegerDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const signal_num1 = config.get<number>('signal_num1',  4); // 行首到 reg/wire/integer/real 左侧的距离
  const signal_num2 = config.get<number>('signal_num2', 16); // 行首到 signed/unsigned 左侧的距离
  const signal_num3 = config.get<number>('signal_num3', 25); // 行首到位宽 "[" 左侧的距离
  const signal_num4 = config.get<number>('signal_num4', 50); // 行首到变量左侧的距离
  const signal_num5 = config.get<number>('signal_num5', 80); // 行首到 ";" 的距离

  // 改进的正则表达式：支持 reg/wire/integer/real，以及 signed/unsigned, 位宽是可选的
  // 确保不匹配二维数组模式
  const regex = /^\s*(reg\b|wire\b|integer\b|real\b)\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;]\s*)?(.*)/;
  const match = line.match(regex);
  // if (!match) return line; // 应该能匹配到

  const type            = match![1].trim();          // 类型：reg/wire/integer/real
  const signedUnsigned  = (match![2] || '').trim(); // signed/unsigned
  const width           = (match![3] || '').trim(); // 位宽声明字符串 (如 [31:0])
  const signal          = match![4].trim();        // 信号名称
  const endSymbol       = (match![5] || '').trim(); // 逗号或分号
  const comment         = (match![6] || '').trim(); // 注释内容

  // **内部处理位宽对齐**
  const alignedWidth = width ? alignBitWidthDeclaration(width, config) : '';

  // 对齐逻辑 - 基于长度计算填充空格
  let currentPos = 0;
  const parts: string[] = [];

  // 1. 对齐 type
  const typeSpaces = Math.max(0, signal_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  // 2. 对齐 signed/unsigned
  const signedSpaces = Math.max(0, signal_num2 - currentPos);
  if (signedUnsigned) {
      parts.push(' '.repeat(signedSpaces) + signedUnsigned);
      currentPos += signedSpaces + signedUnsigned.length;
  }

  // 3. 对齐位宽 "["
  const widthSpaces = Math.max(0, signal_num3 - currentPos);
  if (alignedWidth) { // 使用内部对齐后的位宽
      parts.push(' '.repeat(widthSpaces) + alignedWidth);
      currentPos += widthSpaces + alignedWidth.length;
  }

  // 4. 对齐信号
  const signalSpaces = Math.max(0, signal_num4 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  // 5. 对齐 ";/,"
  const endSymbolAndCommentSpaces = Math.max(0, signal_num5 - currentPos);
   parts.push(' '.repeat(endSymbolAndCommentSpaces) + endSymbol + comment);


  return parts.join('');
}

// 查找下一个空格位置 (此函数在新逻辑中不再需要，基于列数计算空格更精确)
// function findNextSpace(line: string, targetPos: number, currentPos: number): number {
//   let pos = targetPos;
//   while (pos < line.length && line[pos] !== ' ') {
//     pos++;
//   }
//   return Math.max(0, pos - currentPos + 1); // 空一格之后对齐
// }

/**
 * 对齐 parameter/localparam 声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignParamDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const param_num1 = config.get<number>('param_num1', 4 ); // 行首到 parameter/localparam 左侧的距离
  const param_num2 = config.get<number>('param_num2', 25); // 行首到参数信号左侧的距离
  const param_num3 = config.get<number>('param_num3', 50); // 行首到 "=" 的距离
  const param_num4 = config.get<number>('param_num4', 80); // 行首到 ";" 或 "," 或 "//" 的距离

  // 改进的正则表达式：匹配 parameter/localparam，信号，=，值，以及可选的 ,/; 和注释
  // 捕获 endSymbol (,/;) 和 comment 分开，方便处理
  const regex = /^\s*(localparam\b|parameter\b)\s+([^\s=]+)\s*=\s*([^;,\/]+)\s*([;,])?\s*(.*)/;

  const match = line.match(regex);
  if (!match) return line; // 应该能匹配到

  const type      = match[1].trim();         // 类型：parameter/localparam
  const signal    = match[2].trim();       // 参数信号
  const value     = match[3].trim();       // 参数值
  const endSymbol = (match[4] || '').trim(); // 分号或逗号
  const comment   = (match[5] || '').trim(); // 注释内容

  // 对齐逻辑 - 基于长度计算填充空格
  let currentPos = 0;
  const parts: string[] = [];

  // 1. 对齐 type
  const typeSpaces = Math.max(0, param_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  // 2. 对齐信号
  const signalSpaces = Math.max(0, param_num2 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  // 3. 对齐 "="
  const equalsSpaces = Math.max(0, param_num3 - currentPos);
   parts.push(' '.repeat(equalsSpaces) + '=');
   currentPos += equalsSpaces + 1; // +1 for '='

  // Add space after '='
  parts.push(' ');
  currentPos += 1;

  // Add value
  parts.push(value);
  currentPos += value.length;


  // 4. 对齐 ";/," 和注释
  const endSymbolAndCommentSpaces = Math.max(0, param_num4 - currentPos);
  parts.push(' '.repeat(endSymbolAndCommentSpaces) + endSymbol + comment);


  return parts.join('');
}

/**
 * 对齐 assign 声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignAssignDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const assign_num1 = config.get<number>('assign_num1', 4 ); // 行首到 assign 左侧的距离
  const assign_num2 = config.get<number>('assign_num2', 12); // 行首到变量左侧的距离
  const assign_num3 = config.get<number>('assign_num3', 30); // 行首到“=”的距离

  // 改进的正则表达式：匹配 assign，左侧信号，=，右侧值，以及可选的 ; 和注释
  const regex = /^\s*assign\b\s+([^\s=]+)\s*=\s*([^;]+)\s*([;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line; // 应该能匹配到

  const signal    = match[1].trim();    // 左侧信号
  const value     = match[2].trim();    // 右侧值
  const endSymbol = (match[3] || '').trim(); // 分号
  const comment   = (match[4] || '').trim(); // 注释内容

  // 对齐逻辑 - 基于长度计算填充空格
  let currentPos = 0;
  const parts: string[] = [];

  // 1. 对齐 assign 关键字
  const assignSpaces = Math.max(0, assign_num1 - currentPos);
  parts.push(' '.repeat(assignSpaces) + 'assign');
  currentPos += assignSpaces + 'assign'.length;

  // 2. 对齐左侧信号
  const signalSpaces = Math.max(0, assign_num2 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  // 3. 对齐 "="
  const equalsSpaces = Math.max(0, assign_num3 - currentPos);
  parts.push(' '.repeat(equalsSpaces) + '=');
  currentPos += equalsSpaces + 1; // +1 for '='

  // Add space after '='
  parts.push(' ');
  currentPos += 1;

  // Add value
  parts.push(value);
  currentPos += value.length;

  // 4. 对齐 ";/," 和注释
  // 这里没有固定的列，只确保分号和注释紧跟在值后面，或者有配置的列数
   // 简单起见，先紧跟，如果需要固定列对齐，可以增加配置项
   parts.push(endSymbol + comment);
   // currentPos += endSymbol.length + comment.length; // 如果要计算，需要加上

  // 如果需要按 align_num3 之后的某个固定列对齐分号和注释，需要修改这里
  // 比如：const endCommentStart = config.get<number>('assign_comment_start', 80);
  // const endCommentSpaces = Math.max(0, endCommentStart - currentPos);
  // parts.push(' '.repeat(endCommentSpaces) + endSymbol + comment);


  return parts.join('');
}

/**
 * 对齐实例化信号
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignInstanceSignal(line: string, config: vscode.WorkspaceConfiguration): string {
  const inst_num1 = config.get<number>('inst_num1', 8 ); // 实例化信号 " . " 左侧与行首的距离
  const inst_num2 = config.get<number>('inst_num2', 40); // 实例化信号 " . " 到 "(" 的距离
  const inst_num3 = config.get<number>('inst_num3', 80); // 实例化信号 " . " 到 ")" 的距离

  // 改进的正则表达式：匹配 .信号名 (连接信号) ;或, 注释
  const regex = /^\s*\.([^\s]+)\s*\(([^)]+)\)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line; // 应该能匹配到

  // 提取匹配内容
  const signal      = match[1].trim();        // 信号名称 (不含点)
  const connection  = match[2].trim();   // 连接信号
  const endSymbol   = (match[3] || '').trim();     // 分号或逗号
  const comment     = (match[4] || '').trim();       // 注释内容

  // 对齐逻辑 - 基于长度计算填充空格
  let currentPos = 0;
  const parts: string[] = [];

  // 1. 对齐 "." + signal
  const dotSignalSpaces = Math.max(0, inst_num1 - currentPos);
  parts.push(' '.repeat(dotSignalSpaces) + `.${signal}`);
  currentPos += dotSignalSpaces + 1 + signal.length; // +1 for '.'

  // 2. 对齐 "("
  // 目标 "(" 的位置是 inst_num2
  const openParenSpaces = Math.max(0, inst_num2 - currentPos);
  parts.push(' '.repeat(openParenSpaces) + '(');
  currentPos += openParenSpaces + 1; // +1 for '('

  // Add connection
  parts.push(connection);
  currentPos += connection.length;

  // 3. 对齐 ")"
  // 目标 ")" 的位置是 inst_num3
  const closeParenSpaces = Math.max(0, inst_num3 - currentPos);
  parts.push(' '.repeat(closeParenSpaces) + ')');
  currentPos += closeParenSpaces + 1; // +1 for ')'

  // 4. 对齐 ";/," 和注释
  // 紧跟在 ")" 后面
  parts.push(endSymbol + comment);

  return parts.join('');
}

/**
 * 对齐位宽声明的内部 (如 [31:0] -> [31: 0])
 * @param bitwidthString - 位宽声明字符串 (例如 "[31:0]" 或 "[DEPTH-1:0]")
 * @param config - 配置对象
 * @returns 对齐后的位宽字符串 (例如 "[31: 0]")
 */
// 使用 SimpleConfig 接口
interface SimpleConfig {
  get: (key: string, defaultValue: number) => number;
}

function alignBitWidthDeclaration(bitwidthString: string, config: SimpleConfig): string {
  const upbound = config.get('upbound', 2); // 位宽上限的最小宽度
  const lowbound = config.get('lowbound', 2); // 位宽下限的最小宽度

  // 正则表达式匹配位宽声明内部
  // 匹配 [ 之后的内容， : 之后的内容， ] 之前的内容
  const regex = /\[\s*([^:]+)\s*:\s*([^\]]+)\s*\]/;
  const match = bitwidthString.match(regex);

  // 如果没有匹配到有效的位宽格式，返回原始字符串
  if (!match) {
    // console.warn(`alignBitWidthDeclaration: Invalid bitwidth format "${bitwidthString}"`);
    return bitwidthString;
  }

  const up = match[1].trim(); // 位宽上限（如 "DEPTH_W-1"）
  const low = match[2].trim(); // 位宽下限（如 "0"）

  // 对齐位宽部分
  // 使用 padStart 确保最小宽度
  const alignedUp = up.padStart(Math.max(upbound, up.length), ' '); // 确保至少 upbound 宽度，不足左填充
  const alignedLow = low.padEnd(Math.max(lowbound, low.length), ' '); // 确保至少 lowbound 宽度，不足右填充

  // 组合成对齐后的位宽字符串
  return `[${alignedUp}:${alignedLow}]`;
}

/**
 * 对齐二维数组声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignTwoDimArrayDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const array_num1 = config.get<number>('array_num1', 4 );  // 行首到 reg/wire 左侧的距离
  const array_num2 = config.get<number>('array_num2', 16);  // 行首到 signed/unsigned 左侧的距离
  const array_num3 = config.get<number>('array_num3', 25);  // 行首到第一个位宽左侧的距离
  const array_num4 = config.get<number>('array_num4', 50);  // 行首到变量左侧的距离
  const array_num5 = config.get<number>('array_num5', 60);  // 行首到第二个位宽左侧的距离
  const array_num6 = config.get<number>('array_num6', 80);  // 行首到 ";" 的距离

  // 改进的正则表达式：支持 reg/wire、signed/unsigned、两个位宽、变量、分号和注释
  const regex = /^\s*(reg\b|wire\b)\s*(signed|unsigned)?\s*(\[[^\]]+\])\s*([^;,\s]+)\s*(\[[^\]]+\])\s*([;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line; // 应该能匹配到

  const type = (match[1] || '').trim(); // reg/wire
  const signedUnsigned = (match[2] || '').trim(); // signed/unsigned
  const width1 = (match[3] || '').trim(); // 第一个位宽字符串
  const signal = (match[4] || '').trim(); // 变量
  const width2 = (match[5] || '').trim(); // 第二个位宽字符串
  const endSymbol = (match[6] || '').trim(); // 分号
  const comment = (match[7] || '').trim(); // 注释

  // **内部处理两个位宽的对齐**
  const alignedWidth1 = width1 ? alignBitWidthDeclaration(width1, config) : '';
  const alignedWidth2 = width2 ? alignBitWidthDeclaration(width2, config) : '';


  // 对齐逻辑 - 基于长度计算填充空格
  let currentPos = 0;
  const parts: string[] = [];

  // 1. 对齐 type
  const typeSpaces = Math.max(0, array_num1 - currentPos);
  parts.push(' '.repeat(typeSpaces) + type);
  currentPos += typeSpaces + type.length;

  // 2. 对齐 signed/unsigned
  const signedSpaces = Math.max(0, array_num2 - currentPos);
  if (signedUnsigned) {
      parts.push(' '.repeat(signedSpaces) + signedUnsigned);
      currentPos += signedSpaces + signedUnsigned.length;
  }

  // 3. 对齐第一个位宽
  const width1Spaces = Math.max(0, array_num3 - currentPos);
  if (alignedWidth1) { // 使用内部对齐后的位宽
      parts.push(' '.repeat(width1Spaces) + alignedWidth1);
      currentPos += width1Spaces + alignedWidth1.length;
  }

  // 4. 对齐变量
  const signalSpaces = Math.max(0, array_num4 - currentPos);
  parts.push(' '.repeat(signalSpaces) + signal);
  currentPos += signalSpaces + signal.length;

  // 5. 对齐第二个位宽
  const width2Spaces = Math.max(0, array_num5 - currentPos);
  if (alignedWidth2) { // 使用内部对齐后的位宽
      parts.push(' '.repeat(width2Spaces) + alignedWidth2);
      currentPos += width2Spaces + alignedWidth2.length;
  }

  // 6. 对齐分号
  const endSymbolSpaces = Math.max(0, array_num6 - currentPos);
  parts.push(' '.repeat(endSymbolSpaces) + endSymbol);
  currentPos += endSymbolSpaces + endSymbol.length;

  // 7. 对齐注释 (紧跟在分号后面)
  if (comment) {
    parts.push(' ' + comment); // 注释前加一个空格
  }


  return parts.join('');
}
