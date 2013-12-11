define([
  "view",
  "templates/commentView",
  "models/comment"
], function (View, template, CommentModel) {

return View.extend({
  
  name: "commentView",
  
  template: template
});

});
