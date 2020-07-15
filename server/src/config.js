const devMode = require('boolean')(get('DEV_MODE'));

function get(key) {
	return process.env[key];
}

function isDevMode() {
	return devMode;
}

module.exports = {
	get,
	isDevMode
};
