function makeOpt(o, opt, dfd) {
  return $.extend(opt, {
    success: function() {
      dfd.resolveWith(o, arguments);
    },
    error: function() {
      dfd.rejectWith(o, arguments);
    }
  });
}
// o is a backbone object
function bbSave(o, attrs, opt) {
  var dfd = $.Deferred();
  if (!o.save(attrs, makeOpt(o, opt, dfd))) {
    dfd.rejectWith(o, "validation failed");
  }
  return dfd.promise();
}

module.exports = bbSave;
