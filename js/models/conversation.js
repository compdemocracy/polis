define(['model'], function (Model) {
  return Model.extend({
    name: 'conversation',
    path: "conversations",
    idAttribute: "zid",
    defaults: {
      topic: function() {
        return new Date(this.created).toString();
      },
      description: "",
      created: 0,
      owner: undefined,
      participant_count: "",
      url_name: function(){
        var s = "polis.io/#conversation/view/" + this.zid;
        if (this.zinvites) {
          s += "/" + this.zinvites[0]; // TODO deal with multiple?
        }
        return s;
      },
      is_anon: true,
      is_draft: false,
      is_active: false,
      is_public: true, // if false, must validate and have account. 
                       // if no domain specified, sms validation.
                       // if email address not empty string, email validation - ie., school email address.
      email_domain: undefined // @microsoft.com etc if require validation AND 
    }


  });
});
