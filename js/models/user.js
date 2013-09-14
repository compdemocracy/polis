define(['model'], function (Model) {
  return Model.extend({
    name: 'user',
    defaults: {
      uid: undefined,  // user id
      given_name: "",
      family_name: "",
      created: 0,
      username: "",
      email: ""
    }
  });
});
