import {execFileSync} from 'node:child_process';
const sha40=/^[a-f0-9]{40}$/;
export function requireExactCode405Checkout(expected,readHead=()=>execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim()){
 if(!sha40.test(expected??''))throw Error('CODE405: valid 40-character AI0 integrated SHA required');
 let head;try{head=readHead()}catch{throw Error('CODE405: cannot prove git HEAD of integrated checkout')}
 if(!sha40.test(head??'')||head!==expected)
  throw Error('CODE405: git HEAD differs from AUTOIN_INTEGRATION_SHA; reject old-SHA CI evidence');
 return head;
}
