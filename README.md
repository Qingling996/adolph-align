# Adolph-Align

## **Version**  
![Version](https://img.shields.io/badge/version-1.0.5-blue)  
![License](https://img.shields.io/badge/license-MIT-green)  
- 0.0.1 新建，实现括号对齐功能
- 1.0.0 缺失依赖，不可用（新增常规代码对齐、verilog文件树、信号跳转）
- 1.0.1 添加 自建 代码片段(verilog 、vhdl)
- 1.0.2 缺失依赖，不可用
- 1.0.3 删除 log.txt(文件树模块识别记录) 文件生成, 改为console打印
- 1.0.4 增加对real/signed/unsigned的支持，然后对齐指令一次不生效的话，多来几次吧(一般三次即可)
-       增加文件树对vhdl的模块识别支持
-       修改了配置参数名，详情见上 2.2
- 1.0.5 修复配置项修改不成功的bug

---

## 1、简介
自用插件，参考各位大佬和 AI 工具完成的，请不要要求太多。

---

## 2、功能

### 1. 括号内容左中右对齐
选中内容后使用命令：
- `Alt+R`：右对齐
- `Alt+C`：居中对齐
- `Alt+L`：左对齐

### 2. 端口/参数/变量/模块实例化/assign 可配置对齐
选中内容后使用命令：`Alt+A`

可在设置页面进行配置，也可以在 `settings.json` 中设置：

```json
{
  "adolphAlign.port_num1":  4, // Port: 行首到 input/output/inout 左侧的距离
  "adolphAlign.port_num2": 16, // Port: 行首到 signed/unsigned 左侧的距离
  "adolphAlign.port_num3": 25, // Port: 行首到位宽 "[" 左侧的距离
  "adolphAlign.port_num4": 50, // Port: 行首到信号左侧的距离
  "adolphAlign.port_num5": 80, // Port: 行首到 ",/;" 的长度

  "adolphAlign.signal_num1":  4, // 变量: 行首到 reg/wire/integer/real 左侧的距离
  "adolphAlign.signal_num2": 16, // 变量: 行首到 signed/unsigned 左侧的距离
  "adolphAlign.signal_num3": 25, // 变量: 行首到位宽 "[" 左侧的距离
  "adolphAlign.signal_num4": 50, // 变量: 行首到变量左侧的距离
  "adolphAlign.signal_num5": 80, // 变量: 行首到 ";" 的距离

  "adolphAlign.param_num1": 4,  // 参数: 行首到 parameter/localparam 左侧的距离
  "adolphAlign.param_num2": 40, // 参数: 行首到 参数信号左侧的距离
  "adolphAlign.param_num3": 55, // 参数: 行首到 "=" 的距离
  "adolphAlign.param_num4": 80, // 参数: 行首到 ";" 或 "," 或 "//" 的距离

  "adolphAlign.assign_num1": 4,  // assign: 行首到 assign 左侧的距离
  "adolphAlign.assign_num2": 12, // assign: 行首到 变量左侧的距离
  "adolphAlign.assign_num3": 30, // assign: 行首到 “=”的距离

  "adolphAlign.inst_num1": 8,  // 实例化: " . " 左侧与行首的距离
  "adolphAlign.inst_num2": 40, // 实例化: 信号 " . "到“（”的距离
  "adolphAlign.inst_num3": 80, // 实例化: 信号“（”到“）”的距离

  "adolphAlign.array_num1":  4,  // 数组: 行首到 reg/wire 左侧的距离
  "adolphAlign.array_num2": 16,  // 数组: 行首到 signed/unsigned 左侧的距离
  "adolphAlign.array_num3": 25,  // 数组: 行首到第一个位宽左侧的距离
  "adolphAlign.array_num4": 50,  // 数组: 行首到变量左侧的距离
  "adolphAlign.array_num5": 60,  // 数组: 行首到第二个位宽左侧的距离
  "adolphAlign.array_num6": 80,  // 数组: 行首到 ";" 的距离

  "adolphAlign.upbound": 2, // 位宽 [] 内的上限空格数
  "adolphAlign.lowbound": 2  // 位宽 [] 内的下限空格数
}
```
### 3.文件树功能
    入口在左侧，点击即用
### 4.ctrl + 鼠标左键跳转定义
### 5.自用代码片段

---

## 3、仓库
项目地址: [adolph-align](https://github.com/Qingling996/adolph-align)

---

## 4、感谢
- 参考：[Verilog Hdl Format](https://github.com/1391074994/Verilog-Hdl-Format.git)
- 参考：[Verilog-HDL/SystemVerilog/Bluespec SystemVerilog](https://github.com/mshr-h/vscode-verilog-hdl-support.git)
