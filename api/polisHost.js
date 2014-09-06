(function() {
  var firstRun = !window.polis;
  window.polis = window.polis || {};

  function strToHex(str) {
    var hex, i;
    var result = "";
    for (i=0; i<str.length; i++) {
      hex = str.charCodeAt(i).toString(16);
      result += ("000"+hex).slice(-4);
    }
    return result;
  }

  function cookiesEnabledAtTopLevel() {
    // create a temporary cookie 
    var soon = new Date(Date.now() + 1000).toUTCString();
    var teststring = "_polistest_cookiesenabled";
    document.cookie = teststring + "=1; expires=" + soon;  
    // see if it worked
    var cookieEnabled = document.cookie.indexOf(teststring) != -1;
    // clear the cookie
    document.cookie = teststring + "=; expires=" + (new Date(0)).toUTCString();  
    return cookieEnabled;
  }

  function getConfig(d) {
     return {
         demo: d.getAttribute("data-demo"),
         width: d.getAttribute("data-width"),
         height: d.getAttribute("data-height"),
         conversation_id: d.getAttribute("data-conversation_id")
     };
  }
  function createPolisIframe(parent, o) {
    var iframe = document.createElement("iframe");
    var path = [];
    if (o.demo) {
      path.push("demo");
    }
    path.push(o.conversation_id);
    iframe.src = "https://<%= polisHostName %>/"+ path.join("/");
    iframe.width = o.width || 480; // slightly less than iPhone width
    iframe.height = o.height || 900;
    iframe.style.border = "1px solid #ccc";
    iframe.style.borderRadius = "5px";
    // iframe.style.borderTop = "2px solid #ccc";
    // iframe.style.borderLeft = "2px solid #ccc";
    parent.appendChild(iframe);
  }
  function browserCompatibleWithReidrectTrick() {
      var ua = navigator.userAgent;
      if (ua.match(/Firefox/)) {
        if (ua.match(/Android/)) {
          return false;
        }
        return true;
      } else if (ua.match(/Trident/)) { // IE8+
        return true;
      } else if (ua.match(/Safari/)) { // includes Chrome
        return true;
      } else {
        return false
      }
  }

  if (firstRun) {
    window.addEventListener("message", function(event) {
  
      if (!event.origin.match(/pol.is$/)) {
        return;
      } 
    
      if (event.data === "cookieRedirect" && cookiesEnabledAtTopLevel() && browserCompatibleWithReidrectTrick()) {
        // temporarily redirect to polis, which will set a cookie and redirect back
        window.location = "https://preprod.pol.is/api/v3/launchPrep?dest=" + strToHex(window.location+"");
      }
    }, false);
  }

  // Add iframes to any polis divs that don't already have iframes.
  // (check needed since this script may be included multiple times)
  var polisDivs = document.getElementsByClassName("polis");
  for (var i = 0; i < polisDivs.length; i++) {
      var d = polisDivs[i];
      if (d.children && d.children.length) {
          // already populated
      } else {
         var config = getConfig(d);
         createPolisIframe(d, config);
      }
  }
}());



