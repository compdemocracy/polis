define([
  'templates/conversationGatekeeper',
  'models/conversation',
  'views/metadataQuestionsView',
  'collections/MetadataQuestions',
  'util/polisStorage',
  'view',
], function (
  template,
  ConversationModel,
  MetadataQuestionsView,
  MetadataQuestionCollection,
  PolisStorage,
  View
) {
  return View.extend({
    name: 'conversationGatekeeper',
    template: template,
    initialize: function(options) {

      var zinvite = options.zinvite;
      // ConversationModel
      this.model = options.model;
      var zid = this.model.get('zid');

      var metadataCollection = new MetadataQuestionCollection([], {
        zid: zid,
        zinvite: zinvite,
      });

      metadataCollection.fetch({
          data: $.param({
              zid: zid
          }), 
          processData: true,
      });
      this.metadataQuestionsView = new MetadataQuestionsView({
        collection: metadataCollection,
        zid: zid,
        zinvite: zinvite,
      });

      // if (PolisStorage.uid.get()) {
      //   // "hello Joe! Not Joe? (existing) (new)"
      //   this.gatekeeperAuthView = new GatekeeperAuthView({
      //   });
      //   this.gatekeeperAuthView.on('done', function() {
      //     //
      //   });
      // } else {
      //   // create user
      //   this.gatekeeperAuthView = new CreateUserView({
      //     zinvite: zinvite,
      //     zid: zid,
      //   });
      // }
    },
  });
});
