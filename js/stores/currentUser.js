var Backbone = require("backbone");

var preloadHelper = require("../util/preloadHelper");
var currentUserModel = new Backbone.Model();

currentUserModel.update = function() {
  var that = this;
  return preloadHelper.firstUserPromise.then(function(user) {
    // set up global userObject
    window.userObject = $.extend(window.userObject, user);

    window.userObject.uid = void 0;

    // migrating to a singleton model instead.
    that.set(user);
    return user;
  });
};

module.exports = currentUserModel;