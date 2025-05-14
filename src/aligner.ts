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

    // 其他对齐逻辑保持不变
    if (line.includes('[') && line.includes(']')) {
      // 处理变量声明
      let result = alignBitWidthDeclaration(line, config);

      // 如果包含位宽声明，则进一步处理
      if (line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) {
        result = alignPortDeclaration(result, config);
      } else if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer')) {
        // 判断是否为二维数组 /(reg|wire)\s*(\[[^\]]+\])\s*([^;,\s]+)\s*(\[[^\]]+\])\s*([;])?\s*(.*)/
        const isTwoDimArray = /(reg|wire)\s*\[[^\]]+\]\s*[^;,\s]+\s*\[[^\]]+\]/.test(line);
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
      // 处理参数声明
      return alignPortDeclaration(line, config);
    } else if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer')) {
      // 处理参数声明
      return alignRegWireIntegerDeclaration(line, config);
    } else if (line.trim().startsWith('localparam') || line.trim().startsWith('parameter')) {
      // 处理参数声明
      return alignParamDeclaration(line, config);
    } else if (line.trim().startsWith('assign')) {
      // 处理 assign 语句
      return alignAssignDeclaration(line, config);
    } else if (line.trim().startsWith('.')) {
      // 处理实例信号
      return alignInstanceSignal(line, config);
    } else {
      // 其他情况保持原样
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
 */

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

/**
 * 对齐变量声明
 * @param line - 单行文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */

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
  const num9  = config.get<number>('adolphAlign.num9' , 4 ); // 行首到 parameter/localparam 左侧的距离
  const num10 = config.get<number>('adolphAlign.num10', 40); // 行首到参数信号左侧的距离
  const num11 = config.get<number>('adolphAlign.num11', 55); // 行首到 "=" 的距离
  const num18 = config.get<number>('adolphAlign.num18', 80); // 行首到 ";" 或 "," 或 "//" 的距离

  // 改进后的正则表达式，支持注释前没有分号或逗号的情况
  const regex = /^\s*(localparam|parameter)\s+([^\s]+)\s*=\s*([^\s;,]+)\s*([;,])?\s*(.*)/;
  
  // 第一次匹配
  const match = line.match(regex);
  if (!match) return line; // 如果不是 parameter/localparam 声明，直接返回原行

  const type         = match[1] || '';
  const signal       = match[2] || '';
  const value        = match[3] || '';
  const endSymbol    = match[4] || ''; // 捕获分号或逗号
  const comment      = match[5] || ''; // 保留注释内容

  // 删除多余空格后的内容
  const trimmedLine = `${type} ${signal} = ${value} ${endSymbol} ${comment}`.replace(/\s+/g, ' ');

  // 第二次匹配
  const match_new = trimmedLine.match(regex);

  const type_new      = match_new[1] || '';
  const signal_new    = match_new[2] || '';
  const value_new     = match_new[3] || '';

  // 对齐逻辑
  const alignedType = ' '.repeat(num9) + type_new; // 第 9 列开始

  // 对齐信号
  const signalSpaces = Math.max(0, num10 - (num9 + type_new.length)); // 确保非负数
  const alignedSignal = signal_new ? ' '.repeat(signalSpaces) + signal_new : '';

  // 对齐 "="
  const equalsSpaces = Math.max(0, num11 - (num10 + signal_new.length)); // 确保非负数
  const alignedEquals = ' '.repeat(equalsSpaces) + '=';

  // 计算 value_new 和 "=" 的总长度
  const totalLength = alignedType.length + alignedSignal.length + alignedEquals.length + value_new.length + 1; // `=` 和 `value_new` 的总长度 + 1（空格）

  // 查找 `,`、`;` 或注释的位置
  const commaIndex = trimmedLine.indexOf(',');
  const semicolonIndex = trimmedLine.indexOf(';');
  const commentIndex = trimmedLine.indexOf('//');
  const blockCommentIndex = trimmedLine.indexOf('/*');

  // 确定停止删除的位置
  let stopIndex = trimmedLine.length;
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
  const remainingText = (stopIndex !== trimmedLine.length) ? trimmedLine.slice(stopIndex).trim() : '';

  // 判断参数值的末尾位置
  const valueEndPosition = totalLength;

  // 如果参数值的末尾位置小于 num18，则填充空格
  if (valueEndPosition <= num18) {
    if (recognizedSymbol === ',' || recognizedSymbol === ';') {
      // 填充空格到 num18
      const spacesToAdd = num18 - valueEndPosition;
      const result = `${alignedType}${alignedSignal}${alignedEquals} ${value}${' '.repeat(spacesToAdd)}${remainingText}`;
      return result;
    } else if (recognizedSymbol === '//' || recognizedSymbol === '/*') {
      // 填充空格到 num18 + 1
      const spacesToAdd = (num18 + 1) - valueEndPosition;
      const result = `${alignedType}${alignedSignal}${alignedEquals} ${value}${' '.repeat(spacesToAdd/*  + remainingText.length */)} ${remainingText}`;
      return result;
    }
  } else { // 如果参数值的末尾位置大于或等于 num18，则将 参数值的末尾到 （“；”或者“，”或者“//”或者“/*”）之间的空格全部删除
    return trimmedLine;
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
function alignAssignDeclaration(line: string, config: WorkspaceConfiguration): string {
  const num12 = config.get<number>('adolphAlign.num12', 4); // 行首到 assign 左侧的距离
  const num13 = config.get<number>('adolphAlign.num13', 12); // 行首到变量左侧的距离
  const num14 = config.get<number>('adolphAlign.num14', 30); // 行首到“=”的距离

  const regex = /assign\s+([^\s]+)\s*=\s*([^;]+)([;,])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const signal = match[1] || '';
  const value = match[2] || '';
  const endSymbol = match[3] || ''; // 默认添加分号
  const comment = match[4] || ''; // 保留注释内容

  // 对齐逻辑
  const alignedAssign = ' '.repeat(num12) + 'assign';

  // 计算 `signal` 到 `=` 的填充长度
  const signalLength = signal.length;
  const assignLength = num12 + 'assign'.length;
  const signalStartPos = assignLength + 1 + (num13 - (assignLength + 1)); // `signal` 的起始位置
  const equalsPos = signalStartPos + signalLength + 1; // `=` 的当前位置

  // 计算需要填充的长度
  const adjustmentLength = num14 - equalsPos;

  // 如果 `adjustmentLength` 为负数，说明 `=` 的位置已经超过 `num14`，需要增加空格
  // 但为了避免截断 `signal`，我们直接增加空格
  const paddingAfterSignal = Math.max(0, adjustmentLength);

  // 返回对齐后的字符串
  return `${alignedAssign} ${' '.repeat(num13 - (num12 + 'assign'.length + 1))}${signal}${' '.repeat(paddingAfterSignal)} = ${value}${endSymbol}${comment}`;
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
// 定义 SimpleConfig 接口
interface SimpleConfig {
  get: (key: string, defaultValue: number) => number;
}

function alignBitWidthDeclaration(line: string, config: SimpleConfig): string {
  const upbound = config.get('adolphAlign.upbound', 2); // 
  const lowbound = config.get('adolphAlign.lowbound', 2); // 

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

function alignTwoDimArrayDeclaration(line: string, config: WorkspaceConfiguration): string {
  const num19 = config.get<number>('adolphAlign.num19', 4); // 行首到 reg/wire 左侧的距离
  const num20 = config.get<number>('adolphAlign.num20', 16); // 行首到第一个位宽左侧的距离
  const num21 = config.get<number>('adolphAlign.num21', 40); // 行首到变量左侧的距离
  const num22 = config.get<number>('adolphAlign.num22', 55); // 行首到第二个位宽左侧的距离
  const num23 = config.get<number>('adolphAlign.num23', 80); // 行首到 ";" 的距离

  const regex = /(reg|wire)\s*(\[[^\]]+\])\s*([^;,\s]+)\s*(\[[^\]]+\])\s*([;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type      = match[1] || ''; // reg/wire
  const width1    = match[2] || ''; // 第一个位宽
  const signal    = match[3] || ''; // 变量
  const width2    = match[4] || ''; // 第二个位宽
  const endSymbol = match[5] || ''; // 分号
  const comment   = match[6] || ''; // 注释

  // 对齐逻辑
  const alignedType = ' '.repeat(num19) + type; // 第 5 列开始

  // 对齐第一个位宽
  const width1Spaces = Math.max(0, num20 - (num19 + type.length)); // 确保非负数
  const alignedWidth1 = width1 ? ' '.repeat(width1Spaces) + width1 : '';

  // 对齐变量
  const signalSpaces = Math.max(0, num21 - (num20 + width1.length)); // 确保非负数
  const alignedSignal = signal ? ' '.repeat(signalSpaces) + signal : '';

  // 对齐第二个位宽
  const width2Spaces = Math.max(0, num22 - (num21 + signal.length)); // 确保非负数
  const alignedWidth2 = width2 ? ' '.repeat(width2Spaces) + width2 : '';

  // 对齐分号
  const endSymbolSpaces = Math.max(0, num23 - (num22 + width2.length)); // 确保非负数
  const alignedEndSymbol = endSymbol ? ' '.repeat(endSymbolSpaces) + endSymbol : '';

  // 对齐注释
  const alignedComment = comment ? ' ' + comment : '';

  return `${alignedType}${alignedWidth1}${alignedSignal}${alignedWidth2}${alignedEndSymbol}${alignedComment}`;
}
