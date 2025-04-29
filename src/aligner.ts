import { WorkspaceConfiguration } from 'vscode';

// 对齐 Verilog 代码
export function alignVerilogCode(text: string, config: WorkspaceConfiguration): string {
  const lines = text.split('\n');
  const alignedLines = lines.map(line => {
    // 如果是注释行或空行，直接返回
    if (line.trim().startsWith('/*') || line.trim().startsWith('//') || line.trim() === '') {
      return line;
    }

    // 对齐逻辑
    if (line.trim().startsWith('localparam') || line.trim().startsWith('parameter')) {
      return alignParamDeclaration(line, config);
    } else if (line.trim().startsWith('input') || line.trim().startsWith('output') || line.trim().startsWith('inout')) {
      return alignPortDeclaration(line, config);
    } else if (line.trim().startsWith('reg') || line.trim().startsWith('wire') || line.trim().startsWith('integer')) {
      return alignRegWireIntegerDeclaration(line, config);
    } else {
      return line; // 其他情况保持原样
    }
  });

  return alignedLines.join('\n');
}

// 对齐 parameter/localparam 声明
function alignParamDeclaration(line: string, config: WorkspaceConfiguration): string {
  const regex = /(localparam|parameter)\s+([^\s]+)\s*=\s*([^;]+)([;,])?(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1];
  const signal = match[2];
  const value = match[3];
  const endSymbol = match[4] || ';'; // 默认添加分号
  const comment = match[5] || ''; // 保留注释内容

  const alignedType = type.padEnd(config.get<number>('num1') || 12);
  const alignedSignal = signal.padEnd(config.get<number>('num2') || 21);

  return `${alignedType} ${alignedSignal} = ${value}${endSymbol}${comment}`;
}

// 对齐端口声明（input/output/inout）
function alignPortDeclaration(line: string, config: WorkspaceConfiguration): string {
  // 正则表达式优化：确保分号、位宽、信号名称和注释被正确捕获
  const regex = /(input|output|inout)\s*(reg)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1];
  const regKeyword = match[2] || '';
  const width = match[3] || '';
  const signal = match[4];
  const endSymbol = match[5] || ''; // 捕获逗号或分号
  const comment = match[6] || ''; // 保留注释内容

  // 对齐规则
  const alignedType = type.padEnd(config.get<number>('num3') || 8);
  const alignedRegKeyword = regKeyword.padEnd(config.get<number>('num4') || 4);
  const alignedWidth = width.padEnd(config.get<number>('num5') || 15);
  const alignedSignal = signal.padEnd(config.get<number>('num6') || 21);

  // 保持结尾不变
  const finalEndSymbol = endSymbol;

  return `${alignedType} ${alignedRegKeyword} ${alignedWidth} ${alignedSignal}${finalEndSymbol}${comment}`;
}


// 对齐 reg/wire/integer 声明
function alignRegWireIntegerDeclaration(line: string, config: WorkspaceConfiguration): string {
  // 正则表达式优化：捕获数组声明、信号名称、分号和注释
  const regex = /(reg|wire|integer)\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*(?:\[[^\]]+\])?\s*([;,])?\s*(.*)/;
  const match = line.match(regex);
  if (!match) return line;

  const type = match[1];
  const width = match[2] || '';
  const signal = match[3];
  const endSymbol = match[4] || ''; // 如果已经有分号，则不添加
  const comment = match[5] || ''; // 保留注释内容

  const alignedType = type.padEnd(config.get<number>('num7') || 8);
  const alignedWidth = width.padEnd(config.get<number>('num8') || 15);
  const alignedSignal = signal.padEnd(config.get<number>('num9') || 21);

  // 如果已经有分号，则不添加；否则默认添加分号
  const finalEndSymbol = endSymbol ? endSymbol : ';';

  return `${alignedType} ${alignedWidth} ${alignedSignal}${finalEndSymbol}${comment}`;
}
