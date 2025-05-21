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
    if (
      line.trim().startsWith('module') ||
      line.trim().startsWith('function') ||
      line.trim().startsWith('always') ||
      line.trim().startsWith('endmodule') ||
      line.trim().startsWith('endfunction') ||
      line.trim().startsWith('begin') ||
      line.trim().startsWith('end')
    ) {
      return line;
    }

    // 其他对齐逻辑保持不变
    if (line.includes('[') && line.includes(']')) {
      // 处理变量声明
      let result = alignBitWidthDeclaration(line, config);

      // 如果包含位宽声明，则进一步处理
      if (line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) {
        result = alignPortDeclaration(result, config);
      } else if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer') || line.trim().startsWith('real')) {
        // 判断是否为二维数组
        const isTwoDimArray = /(reg|wire)\s*(signed|unsigned)?\s*\[[^\]]+\]\s*[^;,\s]+\s*\[[^\]]+\]/.test(line);
        if (isTwoDimArray) {
          result = alignTwoDimArrayDeclaration(result, config);
        } else {
          result = alignRegWireIntegerDeclaration(result, config);
        }
      } else if (line.trim().startsWith('assign')) {
        result = alignAssignDeclaration(result, config);
      }
      return result;
    } else if (line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) {
      return alignPortDeclaration(line, config);
    } else if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer') || line.trim().startsWith('real')) {
      return alignRegWireIntegerDeclaration(line, config);
    } else if (line.trim().startsWith('localparam') || line.trim().startsWith('parameter')) {
      return alignParamDeclaration(line, config);
    } else if (line.trim().startsWith('assign')) {
      return alignAssignDeclaration(line, config);
    } else if (line.trim().startsWith('.')) {
      return alignInstanceSignal(line, config);
    } else {
      return line;
    }
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

  // 正则表达式：支持 input/output/inout，以及 signed/unsigned
  const regex = /(input|output|inout)\s*(reg|wire)?\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type            = match[1].trim();          // 类型：input/output/inout
  const regKeyword      = (match[2] || '').trim();  // reg/wire 关键字
  const signedUnsigned  = (match[3] || '').trim();  // signed/unsigned
  const width           = (match[4] || '').trim();  // 位宽声明
  const signal          = match[5].trim();          // 信号名称
  const endSymbol       = (match[6] || '').trim();  // 逗号或分号
  const comment         = (match[7] || '').trim();  // 注释内容

  // 对齐逻辑
  const alignedType = ' '.repeat(port_num1) + type; // 第 5 列开始
  const alignedRegKeyword = regKeyword ? ' ' + regKeyword : ''; // reg/wire 关键字

  // 对齐 signed/unsigned
  const signedSpaces = port_num2 - (port_num1 + type.length + alignedRegKeyword.length); // 固定对齐到 port_num2 列
  const alignedSigned = signedUnsigned ? ' '.repeat(signedSpaces) + signedUnsigned : '';

  // 对齐位宽声明
  let alignedWidth = '';
  if (width) {
    const widthSpaces = port_num3 - (port_num1 + type.length + alignedRegKeyword.length + alignedSigned.length); // 固定对齐到 port_num3 列
    alignedWidth = ' '.repeat(widthSpaces) + width;
  }

  // 对齐信号
  const signalStartPos = port_num4; // 第 31 列
  let alignedSignal = '';
  if (width) {
    // 带有位宽声明的信号，从第 31 列开始
    const totalLengthBeforeSignal = port_num1 + type.length + alignedRegKeyword.length + alignedSigned.length + alignedWidth.length;
    alignedSignal = ' '.repeat(signalStartPos - totalLengthBeforeSignal) + signal;
  } else {
    // 不带位宽声明的信号，从第 31 列开始
    const totalLengthBeforeSignal = port_num1 + type.length + alignedRegKeyword.length + alignedSigned.length;
    alignedSignal = ' '.repeat(signalStartPos - totalLengthBeforeSignal) + signal;
  }

  // 对齐分号或逗号以及注释
  let alignedEndSymbolAndComment = '';
  if (endSymbol) {
    // 如果有“;”或“,”，按 port_num5 对齐
    alignedEndSymbolAndComment = ' '.repeat(port_num5 - (signalStartPos + signal.length)) + endSymbol + comment;
  } else if (comment) {
    // 如果没有“;”或“,”，但有注释，注释对齐到 port_num5 + 1
    alignedEndSymbolAndComment = ' '.repeat(port_num5 + 1 - (signalStartPos + signal.length)) + comment;
  }

  return `${alignedType}${alignedRegKeyword}${alignedSigned}${alignedWidth}${alignedSignal}${alignedEndSymbolAndComment}`;
}

/**
 * 对齐变量声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
*/
function alignRegWireIntegerDeclaration(line: string, config: vscode.WorkspaceConfiguration): string {
  const signal_num1 = config.get<number>('signal_num1',  4);   // 行首到 reg/wire/integer/real 左侧的距离
  const signal_num2 = config.get<number>('signal_num2', 16);  // 行首到 signed/unsigned 左侧的距离
  const signal_num3 = config.get<number>('signal_num3', 25); // 行首到位宽 "[" 左侧的距离
  const signal_num4 = config.get<number>('signal_num4', 50);   // 行首到变量左侧的距离
  const signal_num5 = config.get<number>('signal_num5', 80);   // 行首到 ";" 的距离

  // 正则表达式：支持 reg/wire/integer/real，以及 signed/unsigned
  // const regex = /^\s*(reg|wire|integer|real)\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const regex = /^\s*(real|reg|wire|integer)\s*(signed|unsigned)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;]\s*)?(.*)/;

  const match = line.match(regex);
  if (!match) return line; // 如果不是 reg/wire/integer/real 声明，直接返回原行

  const type            = match[1].trim();          // 类型：reg/wire/integer/real
  const signedUnsigned  = (match[2] || '').trim(); // signed/unsigned
  const width           = (match[3] || '').trim(); // 位宽声明
  const signal          = match[4].trim();        // 信号名称
  const endSymbol       = (match[5] || '').trim(); // 逗号或分号
  const comment         = (match[6] || '').trim(); // 注释内容

  // 对齐逻辑
  const alignedType = ' '.repeat(signal_num1) + type; // 第 5 列开始

  // 对齐 signed/unsigned
  const signedSpaces = findNextSpace(line, signal_num2-1, alignedType.length);
  const alignedSigned = signedUnsigned ? ' '.repeat(signedSpaces) + signedUnsigned : '';

  // 对齐位宽 "["
  const widthSpaces = findNextSpace(line, signal_num3-1, alignedType.length + alignedSigned.length);
  const alignedWidth = width ? ' '.repeat(widthSpaces) + width : '';

  // 对齐信号
  const signalSpaces = findNextSpace(line, signal_num4-1, alignedType.length + alignedSigned.length + alignedWidth.length);
  const alignedSignal = signal ? ' '.repeat(signalSpaces) + signal : '';

  // 对齐 ";/,"
  const endSymbolSpaces = findNextSpace(line, signal_num5-1, alignedType.length + alignedSigned.length + alignedWidth.length + alignedSignal.length);
  const alignedEndSymbol = endSymbol ? ' '.repeat(endSymbolSpaces) + endSymbol + comment : '';

  return `${alignedType}${alignedSigned}${alignedWidth}${alignedSignal}${alignedEndSymbol}`;
}

// 查找下一个空格位置
function findNextSpace(line: string, targetPos: number, currentPos: number): number {
  let pos = targetPos;
  while (pos < line.length && line[pos] !== ' ') {
    pos++;
  }
  return Math.max(0, pos - currentPos + 1); // 空一格之后对齐
}

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

  const regex = /^\s*(localparam|parameter)\s+([^\s=]+)\s*=\s*([^;,\/]+)\s*(?:[;,])?\s*(?:\s*(\/\/.*|\/\*.*\*\/))?/;


  // 第一次匹配
  const match = line.match(regex);
  if (!match) return line; // 如果不是 parameter/localparam 声明，直接返回原行

  const type      = match[1].trim();         // 类型：parameter/localparam
  const signal    = match[2].trim();       // 参数信号
  const value     = match[3].trim();       // 参数值
  const endSymbol = (match[4] || '').trim(); // 分号或逗号
  const comment   = (match[5] || '').trim(); // 注释内容

  // console.log(`type     : ${type     }`); // 打印日志
  // console.log(`signal   : ${signal   }`); // 打印日志
  // console.log(`value    : ${value    }`); // 打印日志
  // console.log(`endSymbol: ${endSymbol}`); // 打印日志
  // console.log(`comment  : ${comment  }`); // 打印日志

  // 对齐逻辑
  const alignedType = ' '.repeat(param_num1) + type; // 第 9 列开始

  // 对齐信号
  const signalSpaces = Math.max(0, param_num2 - (param_num1 + type.length)); // 确保非负数
  const alignedSignal = signal ? ' '.repeat(signalSpaces) + signal : '';

  // 计算信号名称的结束位置
  const signalEndPosition = param_num1 + type.length + signalSpaces + signal.length;

  // 如果信号名称的结束位置已经超过或接近 "=" 的对齐位置，则 "=" 直接跟在信号名称后面，保留一个空格
  let alignedEquals = '';
  if (signalEndPosition >= param_num3 - 1) {
    alignedEquals = ` =`; // 保留一个空格
  } else {
    const equalsSpaces = Math.max(0, param_num3 - signalEndPosition); // 确保非负数
    alignedEquals = ' '.repeat(equalsSpaces) + '=';
  }

  // 计算 value 和 "=" 的总长度
  const totalLength = alignedType.length + alignedSignal.length + alignedEquals.length + value.length + 1; // `=` 和 `value` 的总长度 + 1（空格）

  // 查找 `,`、`;` 或注释的位置
  const commaIndex = line.indexOf(',');
  const semicolonIndex = line.indexOf(';');
  const commentIndex = line.indexOf('//');
  const blockCommentIndex = line.indexOf('/*');

  // 确定停止删除的位置
  let stopIndex = line.length;
  let recognizedSymbol = '';

  if (commaIndex !== -1 && commaIndex < stopIndex) {
    stopIndex = commaIndex;
    recognizedSymbol = ',';
  }
  if (semicolonIndex !== -1 && semicolonIndex < stopIndex) {
    stopIndex = semicolonIndex;
    recognizedSymbol = ';';
  }
  if (commentIndex !== -1 && commentIndex < stopIndex) {
    stopIndex = commentIndex;
    recognizedSymbol = '//';
  }
  if (blockCommentIndex !== -1 && blockCommentIndex < stopIndex) {
    stopIndex = blockCommentIndex;
    recognizedSymbol = '/*';
  }

  // 获取剩余文本（删除多余空格）
  const remainingText = (stopIndex !== line.length) ? line.slice(stopIndex).trim() : '';

  // 判断参数值的末尾位置
  const valueEndPosition = totalLength;

  // 如果参数值的末尾位置小于 num12，则填充空格
  if (valueEndPosition <= param_num4) {
    if (recognizedSymbol === ',' || recognizedSymbol === ';') {
      // 填充空格到 param_num4
      const spacesToAdd = param_num4 - valueEndPosition;
      const result = `${alignedType}${alignedSignal}${alignedEquals} ${value}${' '.repeat(spacesToAdd)}${remainingText}`;
      return result;
    } else if (recognizedSymbol === '//' || recognizedSymbol === '/*') {
      // 填充空格到 param_num4 + 1
      const spacesToAdd = (param_num4 + 1) - valueEndPosition;
      const result = `${alignedType}${alignedSignal}${alignedEquals} ${value}${' '.repeat(spacesToAdd)}${remainingText}`;
      return result;
    }
  } else { // 如果参数值的末尾位置大于或等于 param_num4 ，则将 参数值的末尾到 （“；”或者“，”或者“//”或者“/*”）之间的空格全部删除
    return `${alignedType}${alignedSignal}${alignedEquals} ${value}${remainingText}`;
  }

  // 其他情况直接返回原行
  return `${alignedType}${alignedSignal}${alignedEquals} ${value}${endSymbol}${comment}`;
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

  const regex = /assign\s+([^\s]+)\s*=\s*([^;]+)([;,])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const signal    = (match[1] || '').trim();
  const value     = (match[2] || '').trim();
  const endSymbol = (match[3] || '').trim(); // 默认添加分号
  const comment   = (match[4] || '').trim(); // 保留注释内容

  // 对齐逻辑
  const alignedAssign = ' '.repeat(assign_num1) + 'assign';

  // 计算 `signal` 到 `=` 的填充长度
  const signalLength = signal.length;
  const assignLength = assign_num1 + 'assign'.length;
  const signalStartPos = assignLength + 1 + (assign_num2 - (assignLength + 1)); // `signal` 的起始位置
  const equalsPos = signalStartPos + signalLength + 1; // `=` 的当前位置

  // 计算需要填充的长度
  const adjustmentLength = assign_num3 - equalsPos;

  // 如果 `adjustmentLength` 为负数，说明 `=` 的位置已经超过 `assign_num3`，需要增加空格
  // 但为了避免截断 `signal`，我们直接增加空格
  const paddingAfterSignal = Math.max(0, adjustmentLength);

  // 返回对齐后的字符串
  return `${alignedAssign} ${' '.repeat(assign_num2 - (assign_num1 + 'assign'.length + 1))}${signal}${' '.repeat(paddingAfterSignal)} = ${value}${endSymbol}${comment}`;
}

/**
 * 对齐实例化信号
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignInstanceSignal(line: string, config: vscode.WorkspaceConfiguration): string {
  const inst_num1 = config.get<number>('inst_num1', 8 );  // 实例化信号 " . " 左侧与行首的距离
  const inst_num2 = config.get<number>('inst_num2', 40); // 实例化信号 " . " 到 "(" 的距离
  const inst_num3 = config.get<number>('inst_num3', 80); // 实例化信号 "(" 到 ")" 的距离

  // 正则表达式：匹配实例化信号
  const regex = /\.([^\s]+)\s*\(([^)]+)\)([,;])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  // 提取匹配内容
  const signal      = match[1] || '';        // 信号名称
  const connection  = match[2] || '';   // 连接信号
  const endSymbol   = match[3] || '';     // 分号或逗号
  const comment     = match[4] || '';       // 注释内容

  // 去除不必要的空格
  const trimmedSignal = signal.trim();
  const trimmedConnection = connection.trim();
  const trimmedEndSymbol = endSymbol.trim();
  const trimmedComment = comment.trim();

  // 对齐逻辑
  const alignedSignal = ' '.repeat(inst_num1) + `.${trimmedSignal.padEnd(Math.max(0, inst_num2 - inst_num1 - 2))}`;
  const alignedEndSymbol = trimmedEndSymbol; // 去除多余空格
  const alignedComment = trimmedComment; // 去除多余空格

  // 计算当前 `)` 的位置
  const currentRightParenthesisPos = alignedSignal.length + trimmedConnection.length + 2; // +2 是 `(` 和 `)` 的长度

  // 目标 `)` 的位置
  const targetRightParenthesisPos = inst_num3;

  // 计算需要调整的长度
  const adjustmentLength = targetRightParenthesisPos - currentRightParenthesisPos;

  // 调整 `connection` 的长度，确保 `)` 定位到 `inst_num3 + 1`
  let adjustedConnection = `(${trimmedConnection})`;
  if (adjustmentLength > 0) {
    // 如果 `)` 的位置小于 `inst_num3 + 1`，填充空格
    adjustedConnection = `(${trimmedConnection.padEnd(trimmedConnection.length + adjustmentLength)})`;
  } else if (adjustmentLength < 0) {
    // 如果 `)` 的位置大于 `inst_num3 + 1`，仅填充空格，不截断 `connection`
    adjustedConnection = `(${trimmedConnection})`;
  }

  // 返回对齐后的字符串
  return `${alignedSignal} ${adjustedConnection}${alignedEndSymbol}${alignedComment}`;
}

/**
 * 对齐位宽声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
// 定义 SimpleConfig 接口
interface SimpleConfig {
  get: (key: string, defaultValue: number) => number;
}

function alignBitWidthDeclaration(line: string, config: SimpleConfig): string {
  const upbound = config.get('upbound', 2); // 
  const lowbound = config.get('lowbound', 2); // 

  // 改进后的正则表达式，支持匹配包含变量的位宽声明
  const regex = /\[\s*([^\s:]+)\s*:\s*([^\s\]]+)\s*\]/;
  const match = line.match(regex);

  // 如果没有匹配到位宽声明，直接返回原行
  if (!match) {
    // console.log(`未匹配到位宽声明: ${line}`); // 打印日志
    return line;
  }

  const width = match[0]; // 完整的位宽声明（如 [DEPTH_W-1:00  ]）
  const up = match[1].trim(); // 位宽上限（如 DEPTH_W-1）
  const low = match[2].trim(); // 位宽下限（如 00）

  // 对齐位宽部分
  const alignedWidth = `[${up.padStart(upbound, ' ')}:${low.padStart(lowbound, ' ')}]`;
  // 替换原行中的位宽声明
  return line.replace(width, alignedWidth);
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

  // 正则表达式：支持 reg/wire、signed/unsigned、位宽、变量、注释
  const regex = /(reg|wire)\s*(signed|unsigned)?\s*(\[[^\]]+\])\s*([^;,\s]+)\s*(\[[^\]]+\])\s*([;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = (match[1] || '').trim(); // reg/wire
  const signedUnsigned = (match[2] || '').trim(); // signed/unsigned
  const width1 = (match[3] || '').trim(); // 第一个位宽
  const signal = (match[4] || '').trim(); // 变量
  const width2 = (match[5] || '').trim(); // 第二个位宽
  const endSymbol = (match[6] || '').trim(); // 分号
  const comment = (match[7] || '').trim(); // 注释

  // 对齐逻辑
  const alignedType = ' '.repeat(array_num1) + type; // 第 5 列开始

  // 对齐 signed/unsigned
  const signedSpaces = Math.max(0, array_num2 - (array_num1 + type.length)); // 确保非负数
  const alignedSigned = signedUnsigned ? ' '.repeat(signedSpaces) + signedUnsigned : '';

  // 对齐第一个位宽
  let alignedWidth1 = '';
  if (signedUnsigned) {
    // 如果有 signed/unsigned，第一个 `[` 从 array_num3 对齐
    const width1Spaces = Math.max(0, array_num3 - (array_num2 + signedUnsigned.length)); // 确保非负数
    alignedWidth1 = width1 ? ' '.repeat(width1Spaces) + width1 : '';
  } else {
    // 如果没有 signed/unsigned，第一个 `[` 直接从 array_num3 对齐
    const width1Spaces = Math.max(0, array_num3 - (array_num1 + type.length)); // 确保非负数
    alignedWidth1 = width1 ? ' '.repeat(width1Spaces) + width1 : '';
  }

  // 对齐变量
  const signalSpaces = Math.max(0, array_num4 - (array_num3 + width1.length)); // 确保非负数
  const alignedSignal = signal ? ' '.repeat(signalSpaces) + signal : '';

  // 对齐第二个位宽
  const width2Spaces = Math.max(0, array_num5 - (array_num4 + signal.length)); // 确保非负数
  const alignedWidth2 = width2 ? ' '.repeat(width2Spaces) + width2 : '';

  // 对齐分号
  const endSymbolSpaces = Math.max(0, array_num6 - (array_num5 + width2.length)); // 确保非负数
  const alignedEndSymbol = endSymbol ? ' '.repeat(endSymbolSpaces) + endSymbol : '';

  // 对齐注释
  const alignedComment = comment ? ' ' + comment : '';

  // 返回对齐后的字符串
  return `${alignedType}${alignedSigned}${alignedWidth1}${alignedSignal}${alignedWidth2}${alignedEndSymbol}${alignedComment}`;
}
