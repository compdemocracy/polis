define(["collection", "models/comment"], function (Collection, Comment) {
  return Collection.extend({
    name: "comments",
    url: "comments",
    model: Comment
  });
});
