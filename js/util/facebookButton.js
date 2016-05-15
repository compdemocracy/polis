var Strings = require("../strings");


// FB.getLoginStatus(function(response) {
//   if (response.status === 'connected') {
//     alert(1);
//     console.log('Logged in.');
//   }
//   else {



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
    if ("polis_err_reg_fb_verification_email_sent" === o.responseText) {
      alert(Strings.polis_err_reg_fb_verification_email_sent);
    }
    if ("polis_err_reg_fb_verification_noemail_unverified" === o.responseText) {
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
