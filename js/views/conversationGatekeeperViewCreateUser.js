var template = require("../templates/userCreate");
var CreateUserFormView = require("../views/create-user-form");

modules.export = CreateUserFormView.extend({
  name: "conversationGatekeeperViewCreateUser",
  template: template
});