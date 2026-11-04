const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

function wordsForPaths() {
  const words = new Set(['alpha']);
  function collect(value) {
    const group = value.match(/\{([^{}]+)\}/);
    if (group) {
      for (const choice of group[1].split(',')) collect(value.replace(group[0], choice));
      return;
    }
    value = value.replace(/\\\//g, '/').replace(/^\/\^/, '');
    for (const part of value.split('/')) {
      // Only literal public names; parameters, patterns and numeric IDs are omitted.
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(part)) words.add(part);
      else {
        const prefix = part.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\(|\$|\*)/);
        if (prefix) words.add(prefix[1]);
      }
    }
  }
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'server/characterization/inventory.json')));
  for (const route of inventory.routes) collect(route.path);
  const routing = fs.readFileSync(path.join(root, 'file-server/nginx/ROUTING.md'), 'utf8');
  for (const match of routing.matchAll(/`(\/[^`]+)`/g)) collect(match[1]);
  return [...words].sort();
}
module.exports = {wordsForPaths};
if (require.main === module) {
  const value = wordsForPaths().join(' ');
  for (const dir of ['server/src/utils', 'client-participation/js/util', 'client-admin/src/util', 'client-report/src/util', 'client-participation-alpha/src/lib']) {
    const file = path.join(root, dir, 'clientErrorReporter.js');
    const source = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, source.replace(/(var words =\s*)'[^']*'/, '$1' + JSON.stringify(value).replace(/^"|"$/g, "'")));
  }
}
