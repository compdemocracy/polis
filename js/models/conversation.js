define(['model'], function (Model) {
  return Model.extend({
    name: 'conversation',
    path: "conversations",
    idAttribute: "zid",
    urlRoot: 'conversations',
    url: function() {
        return this.urlRoot + "/" + this.id;
    },
    defaults: {
      topic: "", // an empty topic will be shown as a localized date string
      // topic: function() {
      //   return new Date(this.created).toString();
      // },
      description: "",
      created: 0,
      owner: undefined,
      participant_count: "",
      url_name: function(){
        var s = "/#" + this.zid;
        if (this.zinvites) {
          s += "/" + this.zinvites[0]; // TODO deal with multiple?
        }
        return s;
      },
      url_name_with_hostname: function() {
        // build the URL for the user to copy & paste
        var s = "";
        if (/polis/.exec(document.location.hostname)) {
          // production
          s += "https://";
        }
        s += document.location.hostname;
        s += document.location.port ? (":" + document.location.port) : "";
        return s + this.url_name();
      },
      is_anon: false,
      is_draft: false,
      is_active: false,
      is_public: false, // if false, must validate and have account. 
                       // if no domain specified, sms validation.
                       // if email address not empty string, email validation - ie., school email address.
      email_domain: undefined // @microsoft.com etc if require validation AND 
    }


  });
});
