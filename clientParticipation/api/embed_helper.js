(function() {
  var firstRun = !window.polis;
  window.polis = window.polis || {};

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

  function encodeReturnUrl(str) {
    var x, i;
    var result = "";
    for (i=0; i<str.length; i++) {
      x = str.charCodeAt(i).toString(16);
      result += ("000"+x).slice(-4);
    }
    return result;
  }

  if (firstRun) {
    window.addEventListener("message", function(event) {
  
      if (!event.origin.match(/pol.is$/)) {
        return;
      } 
    
      if (event.data === "cookieRedirect" && cookiesEnabledAtTopLevel()) {
        // temporarily redirect to polis, which will set a cookie and redirect back
        window.location = "https://embed.pol.is/api/v3/launchPrep?dest=" + encodeReturnUrl(window.location+"");
      }
    }, false);
  }

}());



