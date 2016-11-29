// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var Model = require("../model");


// hit moderation invite url

// it seems necesary to create a list of moderators for each conversation.
// this is because you want to be able to go moderate from your inbox, even if you're not the owner.

// so the workflow is:
// hit pol.is/m/conversation_id/minvite
// this will fire an event to ensure that you're noted as a moderator.
// if not, you can't PUT to the comments. (that's the least we can do)
// we could prevent rendering the view too, but that's more work.


module.exports = Model.extend({
  name: "conversation",
  path: "conversations",
  idAttribute: "conversation_id",
  urlRoot: "conversations",
  url: function() {
    return this.urlRoot;
  },
  defaults: {
    //topic: "", // an empty topic will be shown as a localized date string
    // topic: function() {
    //   return new Date(this.created).toString();
    // },
    description: "",
    created: 0,
    owner: undefined,
    participant_count: "",
    url_force_vis: function() {
      return "/" + this.conversation_id + "/?vis_type=1";
    },
    url_moderate: function() {
      //        return "/m/" + this.conversation_id + "/" + this.minvite;
      return "/m/" + this.conversation_id;
    },
    url_name: function() {
      return "/" + this.conversation_id;
    },
    url_name_with_hostname: function() {
      // build the URL for the user to copy & paste
      var s = "";
      if (/pol.is/.exec(document.location.hostname)) {
        // production
        s += "https://";
      }
      s += document.location.hostname;
      s += document.location.port ? (":" + document.location.port) : "";
      return s + this.url_name();
    },
    url_name_with_production_hostname: function() {
      return "https://pol.is" + this.url_name();
    },
    is_anon: false,
    is_draft: false,
    is_active: false,
    // is_public: false, // if false, must validate and have account.
    // if no domain specified, sms validation.
    // if email address not empty string, email validation - ie., school email address.
    email_domain: undefined // @microsoft.com etc if require validation AND
  }


});
