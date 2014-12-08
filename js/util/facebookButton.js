
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

  FB.api('/me/friends',function (response) {
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

  FB.api('/me',function (response) {
    console.log("/me done");
    // {"id":"10152802017421079"
    //   "email":"michael@bjorkegren.com"
    //   "first_name":"Mike"
    //   "gender":"male"
    //   "last_name":"Bjorkegren"
    //   "link":"https://www.facebook.com/app_scoped_user_id/10152802017421079/"
    //   "locale":"en_US"
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
      dfd.resolve(response);
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
  return $.when(
    getInfo(),
    getFriends()).then(function(fb_public_profile, friendsData) {

      // alert(JSON.stringify(friendsData));
      console.log("got info and friends");

      var data = {
          // fb_user_id: FB.getUserID(),
          // fb_login_status: FB.getLoginStatus(),
          // fb_auth_response: JSON.stringify(FB.getAuthResponse()),
          // fb_access_token: FB.getAccessToken(),
          fb_public_profile: JSON.stringify(fb_public_profile),
          fb_friends_response: JSON.stringify(friendsData),
          response: JSON.stringify(response)
      };
      if (fb_public_profile.email) {
        data.fb_email = fb_public_profile.email;
      } else {
        data.provided_email = prompt("Please enter your email address.");
      }
      var hname = [fb_public_profile.first_name, fb_public_profile.last_name].join(" ");
      if (hname.length) {
        data.hname = hname;
      }
      if (response && response.authResponse && response.authResponse.grantedScopes) {
        data.fb_granted_scopes = response.authResponse.grantedScopes;
      }
      if (optionalPassword) {
        data.password = optionalPassword;
      }

      return $.ajax({
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
  });
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
        facebookLoginOkHandler(x /*, password */).then(dfd.resolve, dfd.reject);
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
}