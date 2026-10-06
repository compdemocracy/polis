const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const mod={exports:{}};
const source=fs.readFileSync(path.resolve(__dirname,'../../__tests__/setup/vote-path-expected.ts'),'utf8');
new Function('exports','require','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod.exports,require,mod);
exports.isRuled=value=>typeof value==='string'&&value!=='pending'&&mod.exports.RULING.test(value);
