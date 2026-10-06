const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'../../..');
const input=fs.readFileSync(path.join(root,'client-participation-alpha/src/lib/provenance.ts'),'utf8');
const output='// Generated from client-participation-alpha/src/lib/provenance.ts. Do not edit.\n'+ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText;
const dest=path.join(root,'client-report/src/data/provenance.js');
if(process.argv.includes('--check')) {if(fs.readFileSync(dest,'utf8')!==output)throw Error('provenance generation drift');} else fs.writeFileSync(dest,output);
