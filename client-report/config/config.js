// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

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
    // the next line only works with docker-compose
    console.log('reading schema')
    let fileContents = fs.readFileSync('/app/config/schema.yaml', 'utf8');
    let schema = yaml.safeLoad(fileContents);
    var config = convict(schema);    
} catch (e) {
    console.log(e);
}

console.log('default aws_region:' + config.get('aws_region'));

// Load environment dependent configuration
var env = config.get('env');
config.loadFile('/app/config/' + env + '.yaml');
var now = new Date(); 
console.log('config aws_region:' + config.get('aws_region') + " @ " + now.toUTCString());

const path = '/app/config/config_private.yaml';

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


console.log('finishing config.js')

