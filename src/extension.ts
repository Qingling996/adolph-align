import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { alignVerilogCodeDispatcher } from './aligner'; // 导入端口/常量/变量声明对齐功能
import { registerAlignmentCommand } from './alignParentheses'; // 导入括号对齐功能
import { VerilogTreeDataProvider } from './VerilogTreeDataProvider'; // 导入文件树功能
import * as child_process from 'child_process';
import { registerSnippets } from './snippets'; // 导入代码片段功能
import { VerilogDefinitionProvider } from './VerilogDefinitionProvider'; // 导入文件跳转功能

export function activate(context: vscode.ExtensionContext) {
  console.log('ADOLPH ALIGN 插件已激活');

  // 注册 Verilog 对齐命令
  const alignCommand = vscode.commands.registerCommand('adolph-align.align', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const config = vscode.workspace.getConfiguration('adolphAlign');
    const text = editor.document.getText(editor.selection);

    // 生成AST文件
    const verilogPath = editor.document.uri.fsPath;
    // const jarPath = path.join(__dirname, '../resources/jar/verilog-parser-1.0.0.jar');
    const jarPath = context.asAbsolutePath(path.join('resources', 'jar', 'verilog-parser-1.0.0-exe.jar'));

    const tempDir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const astPath = path.join(path.dirname(verilogPath), 'Verilog_AST.json');

    // 【最佳实践】使用前清理临时AST文件
    if (fs.existsSync(astPath)) {
        fs.unlinkSync(astPath);
    }
    
    let useASTMode = false; // 默认不使用AST模式

    // 检查JAR文件是否存在，给用户更明确的提示
    if (!fs.existsSync(jarPath)) {
        console.error(`[Extension] JAR file not found at: ${jarPath}`);
        vscode.window.showErrorMessage('解析器核心文件(verilog-parser-1.0.0-exe.jar)丢失，请重新安装插件。');
    } else {
        try {
            const verilogPath = editor.document.uri.fsPath;
            console.log(`[Extension] Generating AST: java -jar "${jarPath}" "${verilogPath}" "${astPath}"`);
            child_process.execSync(`java -jar "${jarPath}" "${verilogPath}" "${astPath}"`, { stdio: 'pipe' }); // 使用 stdio: 'pipe' 抑制Java输出到VS Code控制台

            if (fs.existsSync(astPath)) {
                useASTMode = true;
                console.log(`[Extension] AST file generated successfully: ${astPath}`);
            } else {
                console.warn(`[Extension] AST file was not generated: ${astPath}`);
            }
        } catch (error: any) {
            console.error('[Extension] AST generation failed:', error.message || error);
            // 【用户体验】给出更具体的错误提示
            if (error.message.includes('java: not found') || error.message.includes('\'java\' is not recognized')) {
                vscode.window.showErrorMessage('AST生成失败：未找到Java运行环境。请安装Java并配置好环境变量。将使用正则表达式模式进行对齐。');
            } else {
                vscode.window.showErrorMessage('AST生成失败，可能是代码存在语法错误。将使用正则表达式模式进行对齐。');
            }
            useASTMode = false;
        }
    }

    // 【修改】调用分发器
    const alignedText = alignVerilogCodeDispatcher(text, config, useASTMode, astPath);

    editor.edit(editBuilder => {
      editBuilder.replace(editor.selection, alignedText);
    });

    // // 【最佳实践】使用完毕后清理临时AST文件
    // if (fs.existsSync(astPath)) {
    //     fs.unlinkSync(astPath);
    // }
    
    // 替换选中的文本
    editor.edit(editBuilder => {
      editBuilder.replace(editor.selection, alignedText);
    });

    console.log('Verilog align executed');
  });

  context.subscriptions.push(alignCommand);

  // 监听配置变化
  vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('adolphAlign')) {
      console.log('配置已修改，重新执行对齐逻辑');
      // 重新执行对齐命令，而不是直接调用 alignVerilogCode，以确保AST生成逻辑也重新运行
      vscode.commands.executeCommand('adolph-align.align'); 
    }
  });

  // 注册括号对齐命令
  console.log('括号对齐 已注册');
  registerAlignmentCommand(context, 'left');
  registerAlignmentCommand(context, 'center');
  registerAlignmentCommand(context, 'right');

  // 注册 snippets
  console.log('snippets 已注册');
  registerSnippets(context, 'verilog');
  registerSnippets(context, 'vhdl');

  // 获取当前工作区根目录
  const workspaceRoot = vscode.workspace.rootPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace root found.');
    return;
  }

  // 注册文件树视图
  const verilogTreeDataProvider = new VerilogTreeDataProvider(workspaceRoot);
  vscode.window.registerTreeDataProvider('verilogFileTree', verilogTreeDataProvider);

  console.log('Verilog File Tree 已注册');

  // 注册刷新命令
  const refreshCommand = vscode.commands.registerCommand('verilogFileTree.refresh', () => {
    verilogTreeDataProvider.refresh();
  });

  // 注册 "在文件夹中显示" 命令
  context.subscriptions.push(vscode.commands.registerCommand('verilogTree.openContainingFolder', (node: any) => {
      // 检查传入的 node 是否是 ModuleNode 实例或包含 resourceUri
      if (node && node.resourceUri && node.resourceUri.scheme === 'file') {
          // 使用 VS Code 内置命令 revealFileInOS
          // 这个命令通常会打开文件所在的文件夹并在文件管理器中选中文件
          vscode.commands.executeCommand('revealFileInOS', node.resourceUri);
      } else {
          vscode.window.showErrorMessage('Cannot open folder: Invalid file path or file not found.');
      }
  }));

  // 注册 DefinitionProvider
  const definitionProvider = new VerilogDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('verilog', definitionProvider)
  );

  // 确保插件激活后调用刷新命令
  vscode.commands.executeCommand('verilogFileTree.refresh');
}

export function deactivate() {
  console.log('ADOLPH ALIGN 插件已停用');
}
