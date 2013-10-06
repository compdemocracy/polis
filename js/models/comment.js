define(['model'], function (Model) {
  return Model.extend({
    name: 'comment',
    urlRoot: 'comments',
    idAttribute: 'tid',
    defaults: {
      tid: undefined,  // comment id
      pid: undefined,
      txt: "This is default comment text defined in the model.",
      created: 0,
  	}
  });
});
