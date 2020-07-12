const convict = require('convict');
const fs = require('fs');

const SCHEMA_FILE = './config/schema.json';
const ENV_CONFIG_PATH = './config/environments/';

let config;

// Define a schema
try {
  if (fs.existsSync(SCHEMA_FILE)) {
    config = convict(SCHEMA_FILE);
  }
} catch(err) {
  console.error(err)
  throw new Error('could not load schema file: ' + SCHEMA_FILE);
}

// Load environment dependent configuration
const env = config.get('env');
const configFile = ENV_CONFIG_PATH + env + '.json';
try {
  if (fs.existsSync(configFile)) {
    config.loadFile(configFile);
  }
} catch(err) {
  console.error(err)
  throw new Error('could not load config file:' + configFile);
}

// Perform validation
config.validate({allowed: 'strict'});

module.exports = config;
