(function () {
  var polis = (window.polis = window.polis || {});
  var firstRun = !window.polis._hasRun;
  polis._hasRun = 1;
  var iframes = [];
  var polisUrl = "https://josh.demos-surveys.co.uk";
  var maxHeightsSeen = {};

  polis.on = polis.on || {};
  polis.on.vote = polis.on.vote || [];
  polis.on.doneVoting = polis.on.doneVoting || [];
  polis.on.write = polis.on.write || [];
  polis.on.resize = polis.on.resize || [];
  polis.on.init = polis.on.init || [];

  function parseQueryParams(startToken, s) {
    if (typeof s !== "string") {
      return {};
    }
    if (s.charAt(0) === startToken) {
      s = s.slice(1);
    }
    var pairStrings = s.split("&");
    var o = {};
    for (var i = 0; i < pairStrings.length; i++) {
      var pair = pairStrings[i].split("=");
      o[pair[0]] = decodeURIComponent(pair[1]);
    }
    return o;
  }

  var paramsHash = parseQueryParams("#", window.location.hash);
  var paramsQuery = parseQueryParams("?", window.location.search);
  var xid = paramsHash.xid || paramsQuery.xid;

  function getConfig(d) {
    return {
      conversation_id: d.getAttribute("data-conversation_id"),
      site_id: d.getAttribute("data-site_id"),
      page_id: d.getAttribute("data-page_id"),
      parent_url: d.getAttribute("data-parent_url"),
      xid: d.getAttribute("data-xid") || xid,
      x_name: d.getAttribute("data-x_name"),
      x_profile_image_url: d.getAttribute("data-x_profile_image_url"),

      border: d.getAttribute("data-border"),
      border_radius: d.getAttribute("data-border_radius"),
      padding: d.getAttribute("data-padding"),
      height: d.getAttribute("data-height"),
      demo: d.getAttribute("data-demo"),

      ucv: d.getAttribute("data-ucv"),
      ucw: d.getAttribute("data-ucw"),
      ucsh: d.getAttribute("data-ucsh"),
      ucst: d.getAttribute("data-ucst"),
      ucsd: d.getAttribute("data-ucsd"),
      ucsv: d.getAttribute("data-ucsv"),
      ucsf: d.getAttribute("data-ucsf"),

      build: d.getAttribute("data-build"),

      ui_lang: d.getAttribute("data-ui_lang"),

      subscribe_type: d.getAttribute("data-subscribe_type"), // 0 for no prompt, 1 for email prompt (1 is default)

      // These config variables will be used to init the conversation.
      // Subsequent loads will not update to these values in our DB.
      // To change the values after the conversation is created, go to the config tab of
      // https://pol.is/m/<conversation_id>
      show_vis: d.getAttribute("data-show_vis"),
      show_share: d.getAttribute("data-show_share"),
      bg_white: d.getAttribute("data-bg_white"),

      auth_needed_to_vote: d.getAttribute("data-auth_needed_to_vote"), // default false
      auth_needed_to_write: d.getAttribute("data-auth_needed_to_write"), // default true
      // Prompt users to auth using Facebook.
      auth_opt_fb: d.getAttribute("data-auth_opt_fb"), // default true
      // Prompt users to auth using Twitter.
      auth_opt_tw: d.getAttribute("data-auth_opt_tw"), // default true
      // This is here in case we add other auth providers (Google, etc), you can preemptively disable them by setting this to false.
      // Example: if auth_opt_fb is true, but auth_opt_allow_3rdparty is false, users will not be prompted to auth using Facebook.
      auth_opt_allow_3rdparty: d.getAttribute("data-auth_opt_allow_3rdparty"), // default true
      dwok: d.getAttribute("data-dwok"),
      topic: d.getAttribute("data-topic"),
    };
  }

  function createPolisIframe(parent, o) {
    var iframe = document.createElement("iframe");
    var path = [];
    o.parent_url = o.parent_url || window.location + "";
    var id = "polis_";
    var paramStrings = [];

    function appendIfPresent(name) {
      if (o[name] !== null && o[name] !== void 0) {
        paramStrings.push(name + "=" + encodeURIComponent(o[name]));
      }
    }
    if (o.conversation_id) {
      if (o.demo) {
        path.push("demo");
      }
      path.push(o.conversation_id);
      id += o.conversation_id;
    } else if (o.site_id) {
      path.push(o.site_id);
      id += o.site_id;
      if (!o.page_id) {
        alert("Error: need data-page_id when using data-site_id");
        return;
      }
      path.push(o.page_id);
      id += "_" + o.page_id;
      appendIfPresent("demo");
    } else {
      alert("Error: need data-conversation_id or data-site_id");
      return;
    }
    var src = polisUrl + "/" + path.join("/");

    appendIfPresent("parent_url");
    if (o.parent_url) {
      paramStrings.push("referrer=" + encodeURIComponent(document.referrer));
    }

    appendIfPresent("build");

    appendIfPresent("xid");
    appendIfPresent("x_name");
    appendIfPresent("x_profile_image_url");
    appendIfPresent("ucv");
    appendIfPresent("ucw");
    appendIfPresent("ucsh");
    appendIfPresent("ucst");
    appendIfPresent("ucsd");
    appendIfPresent("ucsv");
    appendIfPresent("ucsf");

    appendIfPresent("ui_lang");

    appendIfPresent("subscribe_type");

    appendIfPresent("show_vis");
    appendIfPresent("show_share");
    appendIfPresent("bg_white");
    appendIfPresent("auth_needed_to_vote");
    appendIfPresent("auth_needed_to_write");
    appendIfPresent("auth_opt_fb");
    appendIfPresent("auth_opt_tw");
    appendIfPresent("auth_opt_allow_3rdparty");

    appendIfPresent("dwok");

    appendIfPresent("topic");

    if (paramStrings.length) {
      src += "?" + paramStrings.join("&");
    }

    iframe.src = src;
    iframe.width = "100%"; // may be constrained by parent div
    iframe.style.maxWidth = window.innerWidth + "px";
    iframe.height = o.height || 930;
    //iframe.style.border = o.border || "1px solid #ccc";
    iframe.style.borderRadius = o.border_radius || "4px";
    iframe.style.padding = o.padding || "4px"; // 1px ensures that right border shows up on default wordpress theme
    iframe.style.backgroundColor = "white";
    // iframe.style.backgroundColor = "rgb(247, 247, 247)";
    iframe.id = id;
    parent.appendChild(iframe);
    iframes.push(iframe);
  }

  function cookiesEnabledAtTopLevel() {
    // create a temporary cookie
    var soon = new Date(Date.now() + 1000).toUTCString();
    var teststring = "_polistest_cookiesenabled";
    document.cookie = teststring + "=1; expires=" + soon;
    // see if it worked
    var cookieEnabled = document.cookie.indexOf(teststring) != -1;
    // clear the cookie
    document.cookie = teststring + "=; expires=" + new Date(0).toUTCString();
    return cookieEnabled;
  }

  function encodeReturnUrl(str) {
    var x, i;
    var result = "";
    for (i = 0; i < str.length; i++) {
      x = str.charCodeAt(i).toString(16);
      result += ("000" + x).slice(-4);
    }
    return result;
  }

  if (firstRun) {
    // function notifyIframes(message) {
    //   // NOTE: twitterWindow closes itself
    //   for (var i = 0; i < iframes.length; i++) {
    //     var x = iframes[i];
    //     var c = x.contentWindow;
    //     if (c && c.postMessage) {
    //       c.postMessage(message, "*");
    //     }
    //   }
    // }

    window.addEventListener(
      "message",
      function (event) {
        // Exit the event  listener if the data origin isn't our expected value
        var data = event.data || {};
        var domain = event.origin.replace(/^https?:\/\//, "");
        if (!domain.match(/(^|\.)pol.is$/)) {
          return;
        }

        var cbList = polis.on[data.name] || [];
        var cbResults = [];
        for (var i = 0; i < cbList.length; i++) {
          cbResults.push(
            cbList[i]({
              iframe: document.getElementById("polis_" + data.polisFrameId),
              data: data,
            })
          );
        }

        if (data && data.name === "init") {
          for (var r = 0; r < polis.on.init.length; r++) {
            polis.on.init[r](data);
          }
        }

        if (data === "cookieRedirect" && cookiesEnabledAtTopLevel()) {
          //   // temporarily redirect to polis, which will set a cookie and redirect back
          window.location =
            polisUrl +
            "/api/v3/launchPrep?dest=" +
            encodeReturnUrl(window.location + "");
        }
        // if (data === "twitterConnectBegin") {
        //   // open a new window where the twitter auth screen will show.
        //   // that window will redirect back to a simple page that calls window.opener.twitterStatus("ok")
        //   var params = 'location=0,status=0,width=800,height=400';
        //   twitterWindow = window.open(polisUrl + "/api/v3/twitterBtn?dest=" + encodeReturnUrl(window.location+""), 'twitterWindow', params);
        // }

        if (data.name === "resize") {
          var resizeWasHandled = false;
          for (var j = 0; j < cbResults.length; j++) {
            if (cbResults[j] === true) {
              resizeWasHandled = true;
            }
          }
          if (!resizeWasHandled) {
            console.log(data.polisFrameId);
            var frameId = "polis_" + data.polisFrameId;
            var iframe = document.getElementById(frameId);
            var h = data.height;
            if (
              h > maxHeightsSeen[frameId] ||
              typeof maxHeightsSeen[frameId] === "undefined"
            ) {
              // Prevents resize loops and excessive scrollbar flashing by only allowing iframe to expand.
              maxHeightsSeen[frameId] = h;
              iframe.setAttribute("height", h);
            }
          }
        }
      },
      false
    );
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
})();
