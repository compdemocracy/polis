define(["collection", "models/comment"], function (Collection, Comment) {
  return Collection.extend({
    name: "comments",
    model: Comment
  });
});
