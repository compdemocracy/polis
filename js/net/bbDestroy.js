function makeOpt(o, opt, dfd) {
    return $.extend(opt, {
        success: _.bind(dfd.resolveWith, o),
        error: _.bind(dfd.rejectWith, o)
    });
}
// o is a backbone object
function bbDestroy(o, opt){
    var dfd = $.Deferred();
    o.destroy(makeOpt(o, opt, dfd));
    return dfd.promise();
}

module.exports = bbDestroy;