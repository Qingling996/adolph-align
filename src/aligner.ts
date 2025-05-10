import * as vscode from 'vscode';
import { WorkspaceConfiguration } from 'vscode';

/**
 * 对齐 Verilog 代码
 * @param text - 输入的文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
export function alignVerilogCode(text: string, config: WorkspaceConfiguration): string {
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

    // 对齐逻辑
    if (line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) {
      return alignPortDeclaration(line, config);
    } else if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer')) {
      return alignRegWireIntegerDeclaration(line, config);
    } else if (line.trim().startsWith('localparam') || line.trim().startsWith('parameter')) {
      return alignParamDeclaration(line, config);
    } else if (line.trim().startsWith('assign')) {
      return alignAssignDeclaration(line, config);
    } else if (line.trim().startsWith('.')) {
      return alignInstanceSignal(line, config);
    } else if (line.includes('[') && line.includes(']')) {
      return alignBitWidthDeclaration(line, config);
    } else {
      return line; // 其他情况保持原样
    }
  });

  return alignedLines.join('\n');
}

function alignPortDeclaration(line: string, config: WorkspaceConfiguration): string {
  const num1 = config.get<number>('adolphAlign.num1', 4); // 行首到 input/output/inout 左侧的距离
  const num2 = config.get<number>('adolphAlign.num2', 16); // 行首到位宽左侧“[”之间的距离
  const num3 = config.get<number>('adolphAlign.num3', 40); // 行首到信号左侧的距离
  const num4 = config.get<number>('adolphAlign.num4', 80); // 行首到 ",/;" 的长度

  const regex = /(input|output|inout)\s*(reg|wire)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1];
  const regKeyword = match[2] || '';
  const width = match[3] || '';
  const signal = match[4];
  const endSymbol = match[5] || ''; // 捕获逗号或分号
  const comment = match[6] || ''; // 保留注释内容

  // 对齐逻辑
  const alignedType = ' '.repeat(num1) + type; // 第 5 列开始
  const alignedRegKeyword = regKeyword ? ' ' + regKeyword : ''; // reg/wire 关键字

  // 对齐位宽声明
  let alignedWidth = '';
  if (width) {
    alignedWidth = ' '.repeat(num2 - (num1 + type.length + alignedRegKeyword.length)) + width;
  }

  // 对齐信号
  const signalStartPos = num3; // 第 31 列
  let alignedSignal = '';
  if (width) {
    // 带有位宽声明的信号，从第 31 列开始
    const totalLengthBeforeSignal = num1 + type.length + alignedRegKeyword.length + alignedWidth.length;
    alignedSignal = ' '.repeat(signalStartPos - totalLengthBeforeSignal) + signal;
  } else {
    // 不带位宽声明的信号，从第 31 列开始
    const totalLengthBeforeSignal = num1 + type.length + alignedRegKeyword.length;
    alignedSignal = ' '.repeat(signalStartPos - totalLengthBeforeSignal) + signal;
  }

  // 对齐 ";/,"
  const alignedEndSymbol = ' '.repeat(num4 - (signalStartPos + signal.length)) + endSymbol + comment;

  return `${alignedType}${alignedRegKeyword}${alignedWidth}${alignedSignal}${alignedEndSymbol}`;
}

function alignRegWireIntegerDeclaration(line: string, config: WorkspaceConfiguration): string {
  const num5 = config.get<number>('adolphAlign.num5', 4); // 行首到 reg/wire/integer 左侧的距离
  const num6 = config.get<number>('adolphAlign.num6', 16); // 行首到位宽左侧的距离
  const num7 = config.get<number>('adolphAlign.num7', 40); // 行首到变量左侧的距离
  const num8 = config.get<number>('adolphAlign.num8', 80); // 行首到 ";" 的距离

  const regex = /^\s*(reg|wire|integer)\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line; // 如果不是 reg/wire/integer 声明，直接返回原行

  const type = match[1] || '';
  const width = match[2] || '';
  const signal = match[3] || '';
  const endSymbol = match[4] || ''; // 捕获逗号或分号
  const comment = match[5] || ''; // 保留注释内容

  // 对齐逻辑
  const alignedType = ' '.repeat(num5) + type; // 第 5 列开始

  // 对齐位宽声明
  const widthSpaces = Math.max(0, num6 - (num5 + type.length)); // 确保非负数
  const alignedWidth = width ? ' '.repeat(widthSpaces) + width : '';

  // 对齐信号
  const signalSpaces = Math.max(0, num7 - (num5 + type.length + alignedWidth.length)); // 确保非负数
  const alignedSignal = signal ? ' '.repeat(signalSpaces) + signal : '';

  // 对齐 ";/,"
  const endSymbolSpaces = Math.max(0, num8 - (num7 + signal.length)); // 确保非负数
  const alignedEndSymbol = endSymbol ? ' '.repeat(endSymbolSpaces) + endSymbol + comment : '';

  return `${alignedType}${alignedWidth}${alignedSignal}${alignedEndSymbol}`;
}

/**
 * 对齐 parameter/localparam 声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignParamDeclaration(line: string, config: WorkspaceConfiguration): string {
  const num9 = config.get<number>('adolphAlign.num9', 4); // 行首到 parameter/localparam 左侧的距离
  const num10 = config.get<number>('adolphAlign.num10', 40); // 行首到参数信号左侧的距离
  const num11 = config.get<number>('adolphAlign.num11', 80); // 行首到 ";" 的距离

  const regex = /(localparam|parameter)\s+([^\s]+)\s*=\s*([^;]+)([;,])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1] || '';
  const signal = match[2] || '';
  const value = match[3] || '';
  const endSymbol = match[4] || ''; // 默认添加分号
  const comment = match[5] || ''; // 保留注释内容

  // 对齐逻辑
  const alignedType = ' '.repeat(num9) + type; // 绝对位置对齐
  const alignedSignal = ' '.repeat(num10) + signal; // 绝对位置对齐
  const alignedValue = value.padEnd(Math.max(0, num11 - num10 - signal.length)); // 确保非负数

  // 确保 ";" 和注释之间无空格
  const alignedEndSymbol = endSymbol.trim(); // 去除多余空格
  const alignedComment = comment.trim(); // 去除多余空格

  return `${alignedType} ${alignedSignal} = ${alignedValue}${alignedEndSymbol}${alignedComment}`;
}

/**
 * 对齐 assign 声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignAssignDeclaration(line: string, config: WorkspaceConfiguration): string {
  const num12 = config.get<number>('adolphAlign.num12', 4); // 行首到 assign 左侧的距离
  const num13 = config.get<number>('adolphAlign.num13', 12); // 行首到变量左侧的距离
  const num14 = config.get<number>('adolphAlign.num14', 24); // 行首到“=”的距离

  const regex = /assign\s+([^\s]+)\s*=\s*([^;]+)([;,])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const signal = match[1] || '';
  const value = match[2] || '';
  const endSymbol = match[3] || ''; // 默认添加分号
  const comment = match[4] || ''; // 保留注释内容

  // 对齐逻辑
  const alignedAssign = ' '.repeat(num12) + 'assign';
  const alignedSignal = ' '.repeat(num13) + signal;
  const alignedValue = value.padEnd(Math.max(0, num14 - num13 - signal.length)); // 确保非负数

  return `${alignedAssign} ${alignedSignal} = ${alignedValue}${endSymbol}${comment}`;
}

/**
 * 对齐实例化信号
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
function alignInstanceSignal(line: string, config: WorkspaceConfiguration): string {
  const num15 = config.get<number>('adolphAlign.num15', 8); // 实例化信号 " . " 左侧与行首的距离
  const num16 = config.get<number>('adolphAlign.num16', 40); // 实例化信号 " . "到“（”的距离
  const num17 = config.get<number>('adolphAlign.num17', 80); // 实例化信号“（”到“）”的距离

  const regex = /\.([^\s]+)\s*\(([^)]+)\)([,;])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const signal = match[1] || '';
  const connection = match[2] || '';
  const endSymbol = match[3] || ''; // 默认添加分号
  const comment = match[4] || ''; // 保留注释内容

  // 对齐逻辑
  const alignedSignal = ' '.repeat(num15) + `.${signal.padEnd(Math.max(0, num16 - num15 - 2))}`;
  const alignedEndSymbol = endSymbol.trim(); // 去除多余空格
  const alignedComment = comment.trim(); // 去除多余空格

  // 计算当前 `)` 的位置
  const currentRightParenthesisPos = alignedSignal.length + connection.length + 2; // +2 是 `(` 和 `)` 的长度

  // 无论操作前 `)` 的位置是大于还是小于 `num17 + 1`，都将 `)` 定位到 `num17 + 1`
  const targetRightParenthesisPos = num17;

  // 计算需要调整的长度
  const adjustmentLength = targetRightParenthesisPos - currentRightParenthesisPos;

  // 调整 `connection` 的长度，确保 `)` 定位到 `num17 + 1`
  let adjustedConnection = `(${connection})`;
  if (adjustmentLength > 0) {
    // 如果 `)` 的位置小于 `num17 + 1`，填充空格
    adjustedConnection = `(${connection.padEnd(connection.length + adjustmentLength)})`;
  } else if (adjustmentLength < 0) {
    // 如果 `)` 的位置大于 `num17 + 1`，截断 `connection`
    const truncateLength = connection.length + adjustmentLength;
    adjustedConnection = `(${connection.slice(0, Math.max(0, truncateLength))})`;
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
function alignBitWidthDeclaration(line: string, config: WorkspaceConfiguration): string {
  const upbound = config.get<number>('adolphAlign.upbound', 2); // 位宽上限对齐长度
  const lowbound = config.get<number>('adolphAlign.lowbound', 2); // 位宽下限对齐长度

  // 只匹配形如 [数字:数字] 的位宽声明
  const regex = /(\[\s*\d+\s*:\s*\d+\s*\])/;
  const match = line.match(regex);
  if (!match) return line; // 如果不是位宽声明，直接返回原行

  const width = match[1];
  const [up = '', low = ''] = width.slice(1, -1).split(':').map(part => part.trim());

  // 对齐位宽部分
  const alignedWidth = `[${up.padStart(upbound)}:${low.padStart(lowbound)}]`;

  return line.replace(width, alignedWidth);
}
