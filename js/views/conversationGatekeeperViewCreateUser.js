var template = require("../tmpl/userCreate");
var CreateUserFormView = require("../views/create-user-form");


module.exports = CreateUserFormView.extend({
  name: "conversationGatekeeperViewCreateUser",
  template: template
});