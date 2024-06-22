// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("underscore");
var Constants = require("./constants");

// Mapping of routing information to GA analytic tags.
// Each key maps to an object that contains category and action to match gtag parameters.
const methodToEventMap = {
  createConversation: {
    category: "Owner",
    action: "createConversation"
  },
  createUser: {
    category: "SignUp",
    action: "createUser"
  },
  createUserViewFromEinvite: {
    category: "SignUp",
    action: "createUserViewFromEinvite"
  },
  demoConversation: {
    category: "Demo",
    action: "demoConversation"
  },
  inbox: {
    category: "Inbox",
    action: "inbox"
  },
  landingPageView: {
    category: "Landing",
    action: "landingPageView"
  },
  participationView: {
    category: "Participation",
    action: "participationView"
  },
  participationViewWithSuzinvite: {
    category: "Participation",
    action: "participationViewWithSuzinvite"
  },
  settings: {
    category: "Account",
    action: "settings"
  }
};

function routeEvent(routerMethod, methodArgs) {
  if (!Constants.GA_TRACKING_ID) {
    return;
  }

  const event = methodToEventMap[routerMethod];
  
  // check for demo
  if (window.location.href.match(/\/2demo/)) {
    gtag('event', routerMethod, {
      'event_category': 'Demo'
    })
    return;
  }

  // First parameter, if any, passed to the router method
  const param = methodArgs ? methodArgs[0] : null;

  if (event) {
    gtag('event', event.action, {
      'event_category': event.category,
      'event_param': param
    });
  } else {
    gtag('event', routerMethod, {
      'event_category': 'Uncategorized',
      'event_param': param
    });
  }
}

module.exports = {
  routeEvent: routeEvent
};
