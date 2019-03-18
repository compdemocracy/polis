function get(key) {
	return process.env[key];
}

module.exports = {
	get
};
