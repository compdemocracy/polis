// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
