var Strings = require("../strings");


// FB.getLoginStatus(function(response) {
//   if (response.status === 'connected') {
//     alert(1);
//     console.log('Logged in.');
//   }
//   else {


function getFriends() {
  var dfd = $.Deferred();

  function getMoreFriends(friendsSoFar, urlForNextCall) {
    console.log("getMoreFriends");

    return $.get(urlForNextCall).then(function(response) {
      if (response.data.length) {
        for (var i = 0; i < response.data.length; i++) {
          friendsSoFar.push(response.data[i]);
        }
        if (response.paging.next) {
          return getMoreFriends(friendsSoFar, response.paging.next);
        }
        return friendsSoFar;
      } else {
        return friendsSoFar;
      }
    });
  }

  FB.api('/me/friends', function(response) {
    console.log("/me/friends returned");
    if (response && !response.error) {
      // alert(JSON.stringify(response));
      // if (response.data) {
      //   for (var i = 0; i < response.data.length; i++) {
      //     alert(response.data[i]);
      //   }
      // }

      var friendsSoFar = response.data;
      if (response.data.length && response.paging.next) {
        getMoreFriends(friendsSoFar, response.paging.next).then(
          dfd.resolve,
          dfd.reject);
      } else {
        dfd.resolve(friendsSoFar || []);
      }
    } else {
      // alert('failed to find friends');
      dfd.reject(response);
    }
  });
  return dfd.promise();
} // end getFriends

function getInfo() {
  var dfd = $.Deferred();

  FB.api('/me', function(response) {
    console.log("/me done");
    // {"id":"10152802017421079"
    //   "email":"michael@bjorkegren.com"
    //   "first_name":"Mike"
    //   "gender":"male"
    //   "last_name":"Bjorkegren"
    //   "link":"https://www.facebook.com/app_scoped_user_id/10152802017421079/"
    //   "locale":"en_US"
    //   "location": {
    //      "id": "110843418940484",  ------------> we can make another call to get the lat,lng for this
    //      "name": "Seattle, Washington"
    //   },
    //   "name":"Mike Bjorkegren"
    //   "timezone":-7
    //   "updated_time":"2014-07-03T06:38:02+0000"
    //   "verified":true}

    if (response && !response.error) {
      // alert(JSON.stringify(response));
      // if (response.data) {
      //   for (var i = 0; i < response.data.length; i++) {
      //     alert(response.data[i]);
      //   }
      // }

      if (response.location && response.location.id) {
        FB.api('/' + response.location.id, function(locationResponse) {
          console.log("locationResponse");
          console.dir(locationResponse);
          if (locationResponse) {
            response.locationInfo = locationResponse;
          }
          dfd.resolve(response);
        });
      } else {
        dfd.resolve(response);
      }
    } else {
      // alert('failed to find data');
      dfd.reject(response);
    }
  });
  return dfd.promise();
} // end getInfo






function facebookLoginOkHandler(response, optionalPassword) {
  console.log("onFbLoginOk");
  console.dir(response);
  var data = {
    response: JSON.stringify(response)
  };
  if (response && response.authResponse && response.authResponse.grantedScopes) {
    data.fb_granted_scopes = response.authResponse.grantedScopes;
  }
  data.owner = false; // since this is the participation view, don't add them to intercom

  var promise = $.ajax({
    url: "/api/v3/auth/facebook",
    contentType: "application/json; charset=utf-8",
    headers: {
      //"Cache-Control": "no-cache"  // no-cache
      "Cache-Control": "max-age=0"
    },
    xhrFields: {
      withCredentials: true
    },
    // crossDomain: true,
    dataType: "json",
    data: JSON.stringify(data),
    type: "POST"
  });
  promise.fail(function(o) {
    if ("polis_err_reg_fb_verification_email_sent" == o.responseText) {
      alert(Strings.polis_err_reg_fb_verification_email_sent);
    }
    if ("polis_err_reg_fb_verification_noemail_unverified" == o.responseText) {
      alert(Strings.polis_err_reg_fb_verification_noemail_unverified);
    }
  });
  return promise;
}


function fbLoginPrompt() {
  var dfd = $.Deferred();
  FB.login(
    function(x) {
      return facebookLoginOkHandler(x).then(dfd.resolve, dfd.reject);
    }, {
      return_scopes: true, // response should contain the scopes the user allowed
      scope: [
        // 'taggable_friends', // requires review.
        // invitable_friends NOTE: only for games with a fb Canvas presence, so don't use this
        'public_profile',
        'user_location',
        'user_friends',
        'email'
      ].join(',')
    });
  return dfd.promise();
}


function connect() {
  var dfd = $.Deferred();
  if (FB.getAuthResponse()) {
    FB.getLoginStatus(function(x) {
      if (x.status === "connected") {
        facebookLoginOkHandler(x /*, password */ ).then(dfd.resolve, dfd.reject);
      } else {
        // this code path may trigger popup blockers.
        // ideally the fbLoginPrompt call below is called instead.
        fbLoginPrompt().then(dfd.resolve, dfd.reject);
      }
    });
  } else {
    // test for FB.getUserID() so we can show the prompt on the same stack, preventing the popup-blocker from showing.
    fbLoginPrompt().then(dfd.resolve, dfd.reject);
  }
  return dfd.promise();
}

module.exports = {
  connect: connect,
};
