var Model = require("./model");

module.exports = Model.extend({
    name: "user",
    defaults: {
      uid: undefined,  // user id
      hname: "", // human name (the token "name" returns too many results when grepped)
      created: 0,
      username: "",
      email: ""
    }
  });