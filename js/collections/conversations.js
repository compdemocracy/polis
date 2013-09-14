define(['collection', 'models/conversation'], function (Collection, Conversation) {
  return Collection.extend({
    name: 'conversations',
    model: Conversation
  });
});
