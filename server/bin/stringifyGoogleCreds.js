const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[2]))
const s = JSON.stringify(o).replace('\n','');
console.log(s);

