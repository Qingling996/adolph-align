# Adolph-Align

## **Parentheses Align**  
![Version](https://img.shields.io/badge/version-1.0.3-blue)  
![License](https://img.shields.io/badge/license-MIT-green)  

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
  "adolphAlign.num1": 4,  // Port: 行首到 input/output/inout 左侧的距离
  "adolphAlign.num2": 16, // Port: 行首到 位宽左侧“[”之间的距离
  "adolphAlign.num3": 40, // Port: 行首到 信号左侧的距离
  "adolphAlign.num4": 80, // Port: 行首到 ",/;" 的长度

  "adolphAlign.num5": 4,  // 变量: 行首到 reg/wire/integer 左侧的距离
  "adolphAlign.num6": 16, // 变量: 行首到 位宽左侧的距离
  "adolphAlign.num7": 40, // 变量: 行首到 变量左侧的距离
  "adolphAlign.num8": 80, // 变量: 行首到 ";" 的距离

  "adolphAlign.num9": 4,  // 参数: 行首到 parameter/localparam 左侧的距离
  "adolphAlign.num10": 40, // 参数: 行首到 参数信号左侧的距离
  "adolphAlign.num11": 55, // 参数: 行首到 "=" 的距离
  "adolphAlign.num12": 80, // 参数: 行首到 ";" 或 "," 或 "//" 的距离

  "adolphAlign.num13": 4,  // assign: 行首到 assign 左侧的距离
  "adolphAlign.num14": 12, // assign: 行首到 变量左侧的距离
  "adolphAlign.num15": 30, // assign: 行首到 “=”的距离

  "adolphAlign.num16": 8,  // 实例化: " . " 左侧与行首的距离
  "adolphAlign.num17": 40, // 实例化: 信号 " . "到“（”的距离
  "adolphAlign.num18": 80, // 实例化: 信号“（”到“）”的距离

  "adolphAlign.num19": 4,  // 数组: 行首到 reg/wire 左侧的距离
  "adolphAlign.num20": 16, // 数组: 行首到 第一个位宽左侧的距离
  "adolphAlign.num21": 40, // 数组: 行首到 变量左侧的距离
  "adolphAlign.num22": 55, // 数组: 行首到 第二个位宽左侧的距离
  "adolphAlign.num23": 80, // 数组: 行首到 ";" 的距离

  "adolphAlign.upbound": 2, // 位宽 [] 内的上限空格数
  "adolphAlign.lowbound": 2  // 位宽 [] 内的下限空格数
}
```
### 3.文件树功能
    入口在左侧，点击即用
### 4.ctrl + 鼠标左键跳转定义
### 5.自用代码片段
    这个会报语法警告，但不影响使用
---
## 3、仓库
项目地址: [adolph-align](https://github.com/Qingling996/adolph-align)

---

## 4、版本记录
- 0.0.1 新建，实现括号对齐功能
- 1.0.0 缺失依赖，不可用（新增常规代码对齐、verilog文件树、信号跳转）
- 1.0.1 添加 自建 代码片段(verilog 、vhdl)
- 1.0.2 缺失依赖，不可用
- 1.0.3 删除 log.txt(文件树模块识别记录) 文件生成

## 5、感谢
- 参考：[Verilog Hdl Format](https://github.com/1391074994/Verilog-Hdl-Format.git)
- 参考：[Verilog-HDL/SystemVerilog/Bluespec SystemVerilog](https://github.com/mshr-h/vscode-verilog-hdl-support.git)
