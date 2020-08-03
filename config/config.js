console.log('starting config.js')

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

console.log('default aws_region:' + config.get('aws_region'));

// Load environment dependent configuration
var env = config.get('env');
config.loadFile('./config/' + env + '.yaml');
console.log(env + ' aws_region:' + config.get('aws_region'));

// Perform validation
config.validate({allowed: 'strict'});
 
module.exports = config;


console.log('finishing config.js')

