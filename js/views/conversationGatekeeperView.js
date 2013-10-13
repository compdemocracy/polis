define([
  'templates/conversationGatekeeper',
  'views/metadataQuestionsView',
  'collections/MetadataQuestions',
  'util/polisStorage',
  'view',
], function (
  template,
  MetadataQuestionsView,
  MetadataQuestionCollection,
  PolisStorage,
  View
) {
  return View.extend({
    name: 'conversationGatekeeper',
    template: template,
    initialize: function(options) {

      var zid = options.zid;
      var zinvite = options.zinvite;

      var metadataCollection = new MetadataQuestionCollection([], {
        zid: zid,
      });

      metadataCollection.fetch({
          data: $.param({
              zid: zid,
              zinvite: zinvite,
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
