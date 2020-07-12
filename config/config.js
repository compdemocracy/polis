const convict = require('convict');


// convict.addFormat(require('convict-format-with-validator').ipaddress);

// Define a schema
var config = convict({
  env: {
    doc: "The application environment.",
    format: ["production", "development", "test"],
    default: "development",
    env: "NODE_ENV"
  },
  akismet_antispam_api_key: {
    doc: 'akismet_antispam_api_key (ex. a1a11111aa11)',
    format: String,
    default: '',
    env: 'AKISMET_ANTISPAM_API_KEYx'
  },
  foo: {
    doc: 'node-convict debug',
    format: String,
    default: 'foo-text',
    env: 'FOO'
  },
  bar: {
    doc: 'node-convict debug',
    format: String,
    default: 'bar-text',
    env: 'BAR'
  }
});

// Load environment dependent configuration
var env = config.get('env');
config.loadFile('./config/' + env + '.json');

// Perform validation
config.validate({allowed: 'strict'});

module.exports = config;
