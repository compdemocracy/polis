// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

module.exports = {
  init: function() {

    function setCss() {
      $("#IModalOverlay")
        .css("background-color", "rgba(0, 0, 0, 0.35)")
        .css("opacity", "1");
    }

    // gray out the Intercom overlay
    function addMutationObserver() {

      setCss();

      // var el = document.body;
      var el = $("#IModalOverlay")[0];
      if (el && mo.observe) {
        mo.observe(el, {
          attributes: true,
          characterData: false,
          childList: false,
        });
      }
    }

    if (window.MutationObserver && window.MutationObserver) {
      var mo = new MutationObserver(function() {
        console.log("setting intercom modal css");
        setCss();
        mo.disconnect();
        addMutationObserver();
      });
      setTimeout(addMutationObserver, 100);
      setTimeout(addMutationObserver, 500);
      setTimeout(addMutationObserver, 1000);
    }
  }
};