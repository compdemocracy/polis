// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var eb = require("../eventBus");
var Handlebones = require("handlebones");

var PolisModelView = Handlebones.ModelView.extend({

  render: function() {
    eb.trigger(eb.firstRender);
    // this.trigger("beforeRender");
    Handlebones.ModelView.prototype.render.apply(this, arguments);
    // this.trigger("afterRender");
  },

});


module.exports = PolisModelView;
