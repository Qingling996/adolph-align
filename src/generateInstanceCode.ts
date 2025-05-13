// src/generateInstanceCode.ts
export function generateInstanceCode(
  moduleCode: string,
  signalMap: Record<string, string> = {}
): string {
  // 提取模块名称
  const moduleNameMatch = moduleCode.match(/module\s+(\w+)/);
  if (!moduleNameMatch) {
    throw new Error('无法解析模块名称');
  }
  const moduleName = moduleNameMatch[1];

  // 自动生成实例化名称
  const instanceName = `UUT_${moduleName}`;

  // 提取端口信息
  const portPattern = /(input|output|inout)\s+(\[.*?\])?\s*(\w+)/g;
  const ports = [];
  let match;
  while ((match = portPattern.exec(moduleCode)) !== null) {
    const portType = match[1]; // input/output/inout
    const portWidth = match[2] || ''; // 位宽（如 [7:0]）
    const portName = match[3]; // 端口名称
    ports.push({ portType, portWidth, portName });
  }

  // 生成实例化代码
  const instanceCode = [
    `${moduleName} ${instanceName} (`,
    ...ports.map((port) => {
      const signalName = signalMap[port.portName] || port.portName;
      return `  .${port.portName} (${signalName})`;
    }),
    `);`
  ].join('\n');

  return instanceCode;
}
