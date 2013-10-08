// o is a backbone object
function bbFetch(o, opt){
 var dfd = $.Deferred();
 o.fetch($.extend(opt,{
  success: _.bind(dfd.resolveWith, o),
  error: _.bind(dfd.rejectWith, o)}));
 return dfd.promise();
}