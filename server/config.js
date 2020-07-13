const convict = require('convict');
const fs = require('fs');

const SCHEMA_FILE = './config/schema.json';
const ENV_CONFIG_PATH = './config/environments/';

let config;

try {
  if (fs.existsSync(SCHEMA_FILE)) {
    // Define a schema
    config = convict(SCHEMA_FILE);
  }
} catch(err) {
  console.error(err)
  // TODO: Throw real error once app will crash without it.
  //throw new Error('could not load schema file: ' + SCHEMA_FILE);
}

const env = config.get('env');
const configFile = ENV_CONFIG_PATH + env + '.json';
try {
  if (fs.existsSync(configFile)) {
    // Load environment dependent configuration
    config.loadFile(configFile);
    // Perform validation
    config.validate({allowed: 'strict'});
  }
} catch(err) {
  console.error(err)
  // TODO: Throw real error once app will crash without it.
  //throw new Error('could not load config file:' + configFile);
}

module.exports = config;
