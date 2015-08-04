

function isA() {
	return 0 === userObject.uid % 2;
}
function isB() {
	return 1 === userObject.uid % 2;
}

module.exports = {
	isA: isA,
	isB: isB,
};