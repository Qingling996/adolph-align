import * as vscode from 'vscode';
import { WorkspaceConfiguration } from 'vscode';

/**
 * 对齐 Verilog 代码
 * @param text - 输入的文本
 * @param config - 配置对象
 * @returns 对齐后的文本
 */
export function alignVerilogCode(text: string, config: WorkspaceConfiguration): string {
  const alignPorts = config.get<boolean>('adolphAlign.alignPorts', true);
  const alignParameters = config.get<boolean>('adolphAlign.alignParameters', true);
  const alignVariables = config.get<boolean>('adolphAlign.alignVariables', true);
  const alignSpaces = config.get<number>('adolphAlign.alignSpaces', 4);

  const lines = text.split('\n');
  const alignedLines = lines.map(line => {
    // 如果是注释行或空行，直接返回
    if (line.trim().startsWith('/*') || line.trim().startsWith('//') || line.trim() === '') {
      return line;
    }

    // 对齐逻辑
    if ((line.trim().startsWith('localparam') || line.trim().startsWith('parameter')) && alignParameters) {
      return alignParamDeclaration(line, alignSpaces);
    } else if ((line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) && alignPorts) {
      return alignPortDeclaration(line, alignSpaces);
    } else if ((line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer')) && alignVariables) {
      return alignRegWireIntegerDeclaration(line, alignSpaces);
    } else {
      return line; // 其他情况保持原样
    }
  });

  return alignedLines.join('\n');
}

/**
 * 对齐 parameter/localparam 声明
 * @param line - 单行文本
 * @param alignSpaces - 对齐的空格数
 * @returns 对齐后的文本
 */
function alignParamDeclaration(line: string, alignSpaces: number): string {
  const regex = /(localparam|parameter)\s+([^\s]+)\s*=\s*([^;]+)([;,])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1];
  const signal = match[2];
  const value = match[3];
  const endSymbol = match[4] || ''; // 默认添加分号
  const comment = match[5] || ''; // 保留注释内容

  const alignedType = type.padEnd(alignSpaces);
  const alignedSignal = signal.padEnd(alignSpaces * 2);

  return `${alignedType} ${alignedSignal} = ${value}${endSymbol}${comment}`;
}

/**
 * 对齐端口声明（input/output/inout）
 * @param line - 单行文本
 * @param alignSpaces - 对齐的空格数
 * @returns 对齐后的文本
 */
function alignPortDeclaration(line: string, alignSpaces: number): string {
  const regex = /(input|output|inout)\s*(reg|wire)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1];
  const regKeyword = match[2] || '';
  const width = match[3] || '';
  const signal = match[4];
  const endSymbol = match[5] || ''; // 捕获逗号或分号
  const comment = match[6] || ''; // 保留注释内容

  const alignedType = type.padEnd(alignSpaces);
  const alignedRegKeyword = regKeyword.padEnd(alignSpaces);
  const alignedWidth = width.padEnd(alignSpaces * 2);
  const alignedSignal = signal.padEnd(alignSpaces * 3);

  const finalEndSymbol = endSymbol;

  return `${alignedType} ${alignedRegKeyword} ${alignedWidth} ${alignedSignal}${finalEndSymbol}${comment}`;
}

/**
 * 对齐 reg/wire/integer 声明
 * @param line - 单行文本
 * @param alignSpaces - 对齐的空格数
 * @returns 对齐后的文本
 */
function alignRegWireIntegerDeclaration(line: string, alignSpaces: number): string {
  const regex = /(reg|wire|integer)\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*(?:\[[^\]]+\])?\s*([;,])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1];
  const width = match[2] || '';
  const signal = match[3];
  const endSymbol = match[4] || ''; // 如果已经有分号，则不添加
  const comment = match[5] || ''; // 保留注释内容

  const alignedType = type.padEnd(alignSpaces);
  const alignedWidth = width.padEnd(alignSpaces * 2);
  const alignedSignal = signal.padEnd(alignSpaces * 3);

  const finalEndSymbol = endSymbol ? endSymbol : ';';

  return `${alignedType} ${alignedWidth} ${alignedSignal}${finalEndSymbol}${comment}`;
}
