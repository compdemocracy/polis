define(['model'], function (Model) {
  return Model.extend({
    name: 'conversation',
    path: "conversations",
    idAttribute: "zid",
    defaults: {
      topic: "Year,Month,Day,Hours,Minutes",
      description: "",
      created: 0,
      owner: undefined,
      participant_count: "",
      url_name: function(){
        return "polis.io/#conversation/view/" + this.zid;
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
