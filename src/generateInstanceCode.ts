// src/utils/generateInstanceCode.ts
export function generateInstanceCode(moduleCode: string): string {
  // 提取模块名称
  const moduleNameMatch = moduleCode.match(/module\s+(\w+)/);
  if (!moduleNameMatch) {
    throw new Error('无法解析模块名称');
  }
  const moduleName = moduleNameMatch[1];

  // 自动生成实例化名称
  const instanceName = `UUT_${moduleName}`;

  // 提取模块的端口部分
  const modulePortsSection = moduleCode.match(/\(([\s\S]*?)\);/);
  if (!modulePortsSection) {
    throw new Error('无法解析模块端口部分');
  }

  // 从端口部分提取端口信息
  const portSection = modulePortsSection[1];
  const portPattern = /(input|output|inout)\s*(reg|wire)?\s*(\[[^\]]+\])?\s*([^;,\s]+)\s*([,;])?\s*(.*)/g;
  const ports = [];
  let match;
  while ((match = portPattern.exec(portSection)) !== null) {
    const portType = match[1]; // input/output/inout
    const portWidth = match[3] || ''; // 位宽（如 [7:0]）
    const portName = match[4]; // 端口名称
    ports.push({ portType, portWidth, portName });
  }

  // 过滤掉嵌套模块的端口
  const topPorts = ports.filter(port => !port.portName.includes('.'));

  // 计算端口名称的最大长度，用于对齐
  const maxPortNameLength = topPorts.reduce((max, port) => Math.max(max, port.portName.length), 0);

  // 生成实例化代码
  const instanceCode = [
    `/*`,
    `${moduleName} ${instanceName}(`
  ];

  // 添加端口映射
  topPorts.forEach((port, index) => {
    const padding = ' '.repeat(maxPortNameLength - port.portName.length); // 对齐空格
    const line = `    .${port.portName}${padding} (${port.portName} )${index < topPorts.length - 1 ? ',' : ''}`;
    instanceCode.push(line);
  });

  // 添加结束括号
  instanceCode.push(');');
  instanceCode.push('*/');

  return instanceCode.join('\n');
}
