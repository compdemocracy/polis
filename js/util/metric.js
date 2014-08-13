
var foo = {};

function metric(category, action) {
  ga('send', 'event', category, action, {'nonInteraction': true});
}

module.exports = metric;