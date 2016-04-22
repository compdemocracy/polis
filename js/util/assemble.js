function assemble() {
  var obj = {};
  for (var i = 0; i < arguments.length; i++) {
    var candidateKvPairs = arguments[i];
    for (var k in candidateKvPairs) {
      if (candidateKvPairs.hasOwnProperty(k)) {
        if (candidateKvPairs[k] !== undefined) {
          obj[k] = candidateKvPairs[k];
        }
      }
    }
  }
  return obj;
}

module.exports = assemble;
