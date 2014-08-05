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