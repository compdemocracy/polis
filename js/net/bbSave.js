function makeOpt(o, opt, dfd) {
    return $.extend(opt, {
        success: _.bind(dfd.resolveWith, o),
        error: _.bind(dfd.rejectWith, o)
    });
}
// o is a backbone object
function bbSave(o, opt){
    var dfd = $.Deferred();
    if (!o.save(makeOpt(o, opt, dfd))) {
      dfd.rejectWith(o, "validation failed");
    }
    return dfd.promise();
}