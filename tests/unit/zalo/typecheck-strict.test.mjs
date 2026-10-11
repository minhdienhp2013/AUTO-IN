import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

/** AI2-only strict gate. AI0's tsconfig.ai2.json temporarily relaxes
 * exactOptionalPropertyTypes/noUncheckedIndexedAccess. This test MUST NOT.
 * The generated program also works on the standalone AI2 module branch.
 */
test('AI2 compiles with both strict optional flags ENABLED',()=>{
  const base=ts.readConfigFile('tsconfig.json',ts.sys.readFile);
  if(base.error)assert.fail(ts.flattenDiagnosticMessageText(base.error.messageText,'\n'));
  const parsed=ts.parseJsonConfigFileContent(base.config,ts.sys,process.cwd());
  const rootNames=ts.sys.readDirectory(process.cwd(),['.ts'],['**/node_modules','**/dist'],[
    'backend/integrations/zalo/**/*.ts','backend/conversation/**/*.ts','backend/ai/**/*.ts'
  ]);
  assert.ok(rootNames.length>=10,'AI2 source files must be found');
  const options={...parsed.options,noEmit:true,allowImportingTsExtensions:true,
    exactOptionalPropertyTypes:true,noUncheckedIndexedAccess:true,strict:true};
  const program=ts.createProgram({rootNames,options});
  const errors=ts.getPreEmitDiagnostics(program).filter(d=>d.category===ts.DiagnosticCategory.Error);
  const summary=ts.formatDiagnosticsWithColorAndContext(errors,{
    getCanonicalFileName:f=>f,getCurrentDirectory:process.cwd,getNewLine:()=> '\n'
  });
  assert.equal(errors.length,0,summary);
});
