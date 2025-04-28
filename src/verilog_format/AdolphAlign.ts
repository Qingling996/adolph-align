////////////////////////////////////////////////////////////////////////////////
//verilog 代码格式化、对齐
////////////////////////////////////////////////////////////////////////////////

import * as vscode from 'vscode';

const upbound_width  = vscode.workspace.getConfiguration().get('AdolphAlign.num5.upbound')  as number;//default :2
const lowbound_width = vscode.workspace.getConfiguration().get('AdolphAlign.num6.lowbound') as number;;//default :2

function parseBound(bound: string): string {
  // [7:0] => [   7:0]
  const match = /\[\s*(\S+)\s*:\s*(\S+)\s*\]/.exec(bound);
  if (match) {
    const upbound = match[1].padStart(upbound_width);
    const lowbound = match[2].padStart(lowbound_width);
    return `[${upbound}:${lowbound}]`;
  }
  return bound;
}

  // 解析每一行代码
  function parseLine(line: string): string {
    let types = ['port', 'declaration', 'instance', 'assign'];
    // 正则表达式判断类型
    let reg_port = /^\s*(input|output|inout)/;
    let define_reg = /^\s*(reg|wire|integer)/;
    let reg_assign = /^\s*assign/;
    let reg_localparam = /^\s*(localparam|parameter)\s+(\w+)\s*=\s*([^,;]+)\s*(,|;)?/;

//******************************************************
//******************************************************

    let new_line = line;
    const width1 = vscode.workspace.getConfiguration().get('AdolphAlign.num1') as number;//input/output/reg/assign/---等前面的空格数 //default :4
    const width2 = vscode.workspace.getConfiguration().get('AdolphAlign.num2') as number;//signed 位置附件的空格数 //default :6
    const width3 = vscode.workspace.getConfiguration().get('AdolphAlign.num3') as number;//default :17
    const width4 = vscode.workspace.getConfiguration().get('AdolphAlign.num4') as number;//default :27

// 提取注释
    let comments = /(\/\/.*)?$/.exec(line);
    if (comments) {
      var line_no_comments = line.replace(comments[0], "");
      var comment = comments[0];
    } else {
      var line_no_comments = line;
      var comment = "";
    }

//=++++++++++++++++++++++++++++++++
//方案1
//=++++++++++++++++++++++++++++++++
//如果 parseBound 的结果长度超过了 width3(17)，则会计算超出的字符数，并将其从 name 的空格数中减去，确保整行的长度不会超过规定的范围。
    if (reg_port.test(line)) {
      new_line = line_no_comments.replace(/^\s*(input|output|inout)\s*(reg|wire)?\s*(signed)?\s*(\[.*\])?\s*([^;]*\b)\s*(,|;)?.*$/, (_, output, reg, signed, bound, name, comma) => {
        let output_width = 7;
        let reg_width = 5;
        output = output.padEnd(output_width);
        if (reg != undefined)
          reg = reg.padEnd(reg_width);
        else
          reg = "".padEnd(reg_width);
        if (signed != undefined)
          signed = signed.padEnd(width2+1);
        else
          signed = "".padEnd(width2+1);
        if (bound != undefined) {
          let parsedBound = parseBound(bound).padEnd(width3);
          let excessLength = Math.max(parsedBound.length - width3, 0);
          name = name.trim().padEnd(width4 - excessLength);
          bound = parsedBound;
        }
        else {
          bound = "".padEnd(width3);
          name = name.trim().padEnd(width4);
        }
        if (comma == undefined)
          comma = " ";
        if (comment == undefined)
          comment = "";
        return "".padEnd(width1) + output + reg + signed + bound + name + comma + comment;
      });
    }

// reg
    else if (define_reg.test(line)) {
      new_line = line_no_comments.replace(/^\s*(reg|wire|integer)\s*(signed)?\s*(\[.*\])?\s*(\S+)\s*(\[.*\])?\s*(\S+)?\s*(\S+)?\s*;.*$/, (_, reg, signed, bound, name, shuzu,dengyu,num) => {
        reg = reg.padEnd(9);
        if (signed != undefined)
          signed = signed.padEnd(width2+4);
        else
          signed = "".padEnd(width2+4);
        
        if (bound != undefined) //第一个[ : ]
        bound = parseBound(bound).padEnd(width3);
        else
        bound = "".padEnd(width3);

        if (bound != undefined )  
            name = name.trim().padEnd(width4 - Math.max(0, parseBound(bound).length - width3)); //字符的数量
        else
            name = name.trim().padEnd(width4); //字符的数量
    
        if (shuzu != undefined)//第二个[ : ]
            name = name.trim().padEnd(20 - Math.max(0, parseBound(shuzu).length - width3));//字符的数量
          else
            name = name.trim().padEnd(width4 - Math.max(0, parseBound(bound).length - width3) - 2);//字符的数量

        if (shuzu != undefined) //第二个[ : ]
            shuzu = shuzu.padEnd(0); //字符的数量
            // shuzu = shuzu.padEnd(width4 - Math.max(0, parseBound(bound).length - width3)); //字符的数量
        else
            shuzu = "".padEnd(0);

        if (dengyu != undefined) //dengyu
          dengyu = dengyu.padEnd(0);
        else
          dengyu = "".padEnd(2);//补的上面减2的值

          if (num != undefined) //
            num = num.padEnd(0);
          else
            num = "".padEnd(0);
    
        if (comment == undefined)//注释
          comment = "";
        return "".padEnd(width1) + reg + signed + bound + name + shuzu + dengyu +  num + ";" + comment;
      });
    }

// assign
    else if (reg_assign.test(line)) {
      new_line = line_no_comments.replace(/^\s*assign\s*(.*?)\s*=\s*(.*?);\s*.?$/, (_, signal_name, expression) => {
        let assign_operator = "=".padEnd(2);//2的话 空格是1  值需要-1
        signal_name = signal_name.trim().padEnd(width4-1);//这个决定了signal_name这个变量的最大字符个数
        expression = expression.trim().padEnd(0); // ";"前的空格
        if (comment == undefined)
          comment = "";
        return "".padEnd(width1) + "assign".padEnd(width3+19)  + signal_name /*+ "".padEnd(4) */+ assign_operator + "".padEnd(0) + expression + ";" + comment;
      });
    } 

// localparam|parameter
    else if (reg_localparam.test(line_no_comments)) {
      new_line = line_no_comments.replace(/^\s*(localparam|parameter)\s+(\w+)\s*=\s*([^,;]+)\s*(,|;)?/, (_, declaration, signal_name, expression, ending_symbol) => {
          declaration = declaration.padEnd(width3+19);
          let assign_operator = "=".padEnd(2);//2的话 空格是1  值需要-1
          signal_name = signal_name.trim().padEnd(width4-1);//这个决定了signal_name这个变量的最大字符个数
          expression = expression.trim().padEnd(6);// ";"前的空格
          if (ending_symbol == undefined) {
              ending_symbol = "";
          }
          return "".padEnd(width1) + declaration + signal_name + assign_operator + expression + ending_symbol;
      });
      new_line = new_line + comment; // 将注释添加回行的末尾
    }

    else if (line_no_comments.trim().length > 0) {
      // 对齐注释
      line_no_comments = line_no_comments.replace(/\t/g, "".padEnd(4));
      line_no_comments = line_no_comments.trimEnd();
      if (comment.length > 0)
        line_no_comments = line_no_comments.padEnd(68);
      new_line = line_no_comments + comment;
    }
    return new_line;
}

  // 简单对齐函数
export function AdolphAlign() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const fileName = editor.document.fileName;
    if (!(fileName.endsWith(".v"))) return;
    const sel = editor.selection; // 只处理一个选择区域
    editor.edit((builder) => {
      for (let i = sel.start.line; i <= sel.end.line; i++) {
        if (!editor) continue;
        let line = editor.document.lineAt(i);
        let new_line = parseLine(line.text);
        if (new_line.localeCompare(line.text) != 0) {
          let line_range = new vscode.Range(line.range.start, line.range.end);
          builder.replace(line_range, new_line);
        }
      }
    });
  }