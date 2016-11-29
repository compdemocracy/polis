// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("underscore");

// Mapping of routing information to GA analytic tags (category, action, etc). By default "action"
// is the method name. XXX: In the future, if we change method names should make this more uniform
// so GA remains consistent; maybe integrating the GA data directly into the router?
var methodToEventMap = {
  createConversation: ["Ownering"],
  participationView: ["Participation", "land"],
  createUser: ["SignUp"],
  // XXX - currently emmited from view
  //login: ["Session"],
  //logout: ["Session"],
  createUserViewFromEinvite: ["Signup", "submit", "createUserViewFromEinvite"], // ???
  settings: ["Account"],
  inbox: ["Inbox", "land"],
  faq: ["Learning"],
  pwresetinit: ["Account"],
  pwReset: ["Account"],
  prototype: [], // ???
  landingPageView: ["Lander", "land"],
  participationViewWithSuzinvite: ["Participation", "land"],
  demoConversation: ["Demo"],
  shareView: ["Ownering"],
  moderationView: ["Ownering"]
};

// Elsewhere:
// SignUp, land
// SignUp, emailSubmitted, general|edu
// SignUp, emailSubmitFail
// SignUp, done
// Lander, land, general|edu
// Session, land
// Session, create, signIn|signUp|empty
// Session, createFail, signIn|signUp|polis_err_no_matching_suzinvite
//

function gaEvent() {
  // Sends all arguments to a ga('send', 'event', __) partial
  ga_ = _.partial(ga, 'send', 'event');
  ga_.apply(window, arguments);
}

function routeEvent(methodNameToCall, methodArgs) {
  // check for demo
  var loc = document.location + "";
  if (loc.match(/\/2demo/)) {
    gaEvent("Demo", "land", loc);
  } else {
    var args = methodToEventMap[methodNameToCall];
    if (args) {
      if (args.length < 2) {
        // Apply action default as described above methodToEventMap
        args.push(methodNameToCall);
      }
      if (args[0] === "Participation" || args[0] === "Demo") {
        // XXX - need to be careful in future if we introduce more Participation category actions that trigger
        // from routes
        args.push(methodArgs[0]);
      }
      gaEvent.apply(window, args);
    }
  }
}

module.exports = {
  gaEvent: gaEvent,
  routeEvent: routeEvent
};
