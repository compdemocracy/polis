define([
  'templates/userCreate',
  'views/create-user-form',
], function (
  template,
  CreateUserFormView
) {
  return CreateUserFormView.extend({
    name: 'conversationGatekeeperViewCreateUser',
    template: template,
  });
});
