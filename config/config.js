console.log('starting yaml config.js')

const convict = require('convict');
const fs = require('fs');
const yaml = require('js-yaml');

convict.addParser({ extension: ['yml', 'yaml'], parse: yaml.safeLoad });

// for additional validation options, use the following: 
// convict.addFormat(require('convict-format-with-validator').ipaddress);

'use strict';

// Define a schema

try {
    let fileContents = fs.readFileSync('./config/schema.yaml', 'utf8');
    let schema = yaml.safeLoad(fileContents);
    var config = convict(schema);    
} catch (e) {
    console.log(e);
}

// Load environment dependent configuration
var env = config.get('env');
config.loadFile('./config/' + env + '.yaml');

const path = './config/config_private.yaml';

try {
  if (fs.existsSync(path)) {
    config.loadFile(path);
  }
} catch(err) {
  console.error(err)
}

// Perform validation
config.validate({allowed: 'strict'});
 
module.exports = config;

console.log('finishing yaml config.js')