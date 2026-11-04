const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root=path.resolve(__dirname,'../../../..');
for (const [file, marker] of [
 ['client-admin/src/index.js',"import './util/clientErrors'"],
 ['client-report/src/index.js','import "./util/clientErrors"'],
 ['client-participation/js/main.js','require("./util/clientErrors")'],
 ['client-participation-alpha/src/pages/layouts/Layout.astro',"import '../../lib/clientErrors'"]
]) test(file+' installs reporting at the entry',()=>assert.ok(fs.readFileSync(path.join(root,file),'utf8').includes(marker)));
for(const file of ['client-admin/src/util/net.js','client-report/src/util/net.js','client-participation/js/util/net.js','client-participation-alpha/src/components/VisualizationContainer.tsx'])
  test(file+' reports read failures explicitly',()=>assert.ok(fs.readFileSync(path.join(root,file),'utf8').includes('reportClientFetch(')));
for (const [template, config] of [
 ['client-admin/public/index.html','client-admin/webpack.config.js'],
 ['client-report/public/index.html','client-report/webpack.common.js'],
 ['client-participation/public/index.ejs','client-participation/webpack.config.js']
]) test(template+' installs an inline prelude before assets',()=>{
  const html=fs.readFileSync(path.join(root,template),'utf8');
  const scripts=html.indexOf('clientErrorPrelude');
  assert.ok(scripts>0); assert.ok(scripts<html.indexOf('<link')||html.indexOf('<link')<0);
  assert.ok(scripts<html.indexOf('<script',html.indexOf('<script')+1));
  assert.match(fs.readFileSync(path.join(root,config),'utf8'),/client-error-prelude\.cjs/);
});
test('alpha installs inline prelude in head before all assets',()=>{
  const html=fs.readFileSync(path.join(root,'client-participation-alpha/src/pages/layouts/Layout.astro'),'utf8');
  assert.match(html,/clientErrorReporter\.js\?raw/);
  assert.ok(html.indexOf('set:html={clientErrorPrelude}')<html.indexOf('<link'));
});
