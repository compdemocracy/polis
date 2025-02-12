// Self-contained embed script for preprod.pol.is

(function() {
  const polis = window.polis = window.polis || {};
  const firstRun = !window.polis._hasRun;
  polis._hasRun = 1;
  const iframes = [];
  const serviceUrl = window.location.protocol + "//preprod.pol.is";
  const maxHeightsSeen = {};

  // Initialize event handlers if not already present
  polis.on = polis.on || {};
  polis.on.vote = polis.on.vote || [];
  polis.on.doneVoting = polis.on.doneVoting || [];
  polis.on.write = polis.on.write || [];
  polis.on.resize = polis.on.resize || [];
  polis.on.init = polis.on.init || [];

  function parseQueryParams(startToken, queryString) {
    if (typeof queryString !== "string") return {};
    
    const cleanQueryString = queryString.startsWith(startToken) ? queryString.slice(1) : queryString;
    
    return Object.fromEntries(
      cleanQueryString
        .split('&')
        .map(pair => pair.split('='))
        .map(([key, value]) => [key, decodeURIComponent(value)])
    );
  }

  const paramsHash = parseQueryParams("#", window.location.hash);
  const paramsQuery = parseQueryParams("?", window.location.search);
  const xid = paramsHash.xid ?? paramsQuery.xid;

  // Default configuration values for UI display
  const DEFAULT_CONFIG = {
    // Visual defaults
    border: '1px solid #ccc',
    border_radius: '4px',
    padding: '4px',
    height: 930,
    
    // Basic display settings
    bg_white: true
  };

  function getConfig(element) {
    function getAttr(name) {
      return element.getAttribute("data-" + name);
    }
    
    return {
      conversation_id: getAttr('conversation_id'),
      site_id: getAttr('site_id'),
      page_id: getAttr('page_id'),
      parent_url: getAttr('parent_url'),
      xid: getAttr('xid') ?? xid,
      x_name: getAttr('x_name'),
      x_profile_image_url: getAttr('x_profile_image_url'),

      // Visual settings
      border: getAttr('border'),
      border_radius: getAttr('border_radius'),
      padding: getAttr('padding'),
      height: getAttr('height'),
      demo: getAttr('demo'),

      // User customization
      ucv: getAttr('ucv'),
      ucw: getAttr('ucw'),
      ucsh: getAttr('ucsh'),
      ucst: getAttr('ucst'),
      ucsd: getAttr('ucsd'),
      ucsv: getAttr('ucsv'),
      ucsf: getAttr('ucsf'),

      ui_lang: getAttr('ui_lang'),
      subscribe_type: getAttr('subscribe_type'),

      // Display configuration
      show_vis: getAttr('show_vis'),
      show_share: getAttr('show_share'),
      bg_white: getAttr('bg_white'),

      // Auth settings
      auth_needed_to_vote: getAttr('auth_needed_to_vote'),
      auth_needed_to_write: getAttr('auth_needed_to_write'),
      auth_opt_fb: getAttr('auth_opt_fb'),
      auth_opt_tw: getAttr('auth_opt_tw'),
      auth_opt_allow_3rdparty: getAttr('auth_opt_allow_3rdparty'),
      
      dwok: getAttr('dwok'),
      topic: getAttr('topic')
    };
  }

  function createPolisIframe(parent, config) {
    const iframe = document.createElement("iframe");
    const path = [];
    const paramStrings = [];
    
    // Set parent URL with fallback to current location
    config.parent_url = config.parent_url || window.location+"";
    
    function appendParam(paramName) {
      if (config[paramName] != null) {
        paramStrings.push(paramName + "=" + encodeURIComponent(config[paramName]));
      }
    }

    // Build the iframe ID and source path
    let iframeId = "polis_";
    if (config.conversation_id) {
      if (config.demo) path.push("demo");
      path.push(config.conversation_id);
      iframeId += config.conversation_id;
    } else if (config.site_id) {
      path.push(config.site_id);
      iframeId += config.site_id;
      
      if (!config.page_id) {
        console.error("Error: need data-page_id when using data-site_id");
        return;
      }
      
      path.push(config.page_id);
      iframeId += "_" + config.page_id;
      appendParam("demo");
    } else {
      console.error("Error: need data-conversation_id or data-site_id");
      return;
    }

    // Build the source URL with parameters
    let srcUrl = serviceUrl + "/" + path.join("/");
    
    // Add parent URL and referrer
    appendParam("parent_url");
    if (config.parent_url) {
      paramStrings.push("referrer=" + encodeURIComponent(document.referrer));
    }

    // User identification params
    ['xid', 'x_name', 'x_profile_image_url'].forEach(appendParam);

    // User customization params
    ['ucv', 'ucw', 'ucsh', 'ucst', 'ucsd', 'ucsv', 'ucsf'].forEach(appendParam);

    // UI and display params
    ['ui_lang', 'subscribe_type', 'show_vis', 'show_share', 'bg_white'].forEach(appendParam);

    // Auth params
    [
      'auth_needed_to_vote',
      'auth_needed_to_write',
      'auth_opt_fb',
      'auth_opt_tw',
      'auth_opt_allow_3rdparty'
    ].forEach(appendParam);

    // Additional params
    ['dwok', 'topic'].forEach(appendParam);

    // Append parameters to source URL if any exist
    if (paramStrings.length) {
      srcUrl += "?" + paramStrings.join("&");
    }

    // Set iframe attributes
    Object.assign(iframe, {
      src: srcUrl,
      id: iframeId,
      width: '100%',
      height: config.height ?? DEFAULT_CONFIG.height
    });

    // Set iframe styles
    Object.assign(iframe.style, {
      maxWidth: window.innerWidth + "px",
      border: config.border ?? DEFAULT_CONFIG.border,
      borderRadius: config.border_radius ?? DEFAULT_CONFIG.border_radius,
      padding: config.padding ?? DEFAULT_CONFIG.padding,
      backgroundColor: 'white'
    });

    // Add test ID for e2e testing
    iframe.setAttribute('data-test-id', 'polis-iframe');
    
    // Append iframe and track it
    parent.appendChild(iframe);
    iframes.push(iframe);
  }

  function cookiesEnabledAtTopLevel() {
    // create a temporary cookie
    const expiryTime = new Date(Date.now() + 1000).toUTCString();
    const testCookieName = "_polistest_cookiesenabled";
    document.cookie = testCookieName + "=1; expires=" + expiryTime;
    
    // see if it worked
    const cookieEnabled = document.cookie.includes(testCookieName);
    
    // clear the cookie
    document.cookie = testCookieName + "=; expires=" + (new Date(0)).toUTCString();
    return cookieEnabled;
  }

  function encodeReturnUrl(str) {
    let result = "";
    for (let i = 0; i < str.length; i++) {
      const x = str.charCodeAt(i).toString(16);
      result += ("000" + x).slice(-4);
    }
    return result;
  }

  if (firstRun) {
    window.addEventListener("message", function(event) {
      const data = event.data ?? {};
      const domain = event.origin.replace(/^https?:\/\//, '');
      
      // Validate message origin for preprod
      if (!domain.match(/(^|\.)preprod\.pol\.is$/)) {
        return;
      }

      // Handle callbacks for the event
      const callbacks = polis.on[data.name] ?? [];
      const callbackResults = callbacks.map(cb => cb({
        iframe: document.getElementById("polis_" + data.polisFrameId),
        data
      }));

      // Handle init events
      if (data?.name === "init") {
        polis.on.init.forEach(handler => handler(data));
      }

      // Handle cookie redirect
      if (data === "cookieRedirect" && cookiesEnabledAtTopLevel()) {
        window.location = serviceUrl + "/api/v3/launchPrep?dest=" + encodeReturnUrl(window.location+"");
      }

      // Handle resize events
      if (data.name === "resize") {
        const resizeWasHandled = callbackResults.some(result => result === true);
        
        if (!resizeWasHandled) {
          const frameId = "polis_" + data.polisFrameId;
          const iframe = document.getElementById(frameId);
          const height = data.height;
          
          // Only allow iframe to expand to prevent resize loops
          if (height > (maxHeightsSeen[frameId] ?? 0)) {
            maxHeightsSeen[frameId] = height;
            iframe.setAttribute("height", height);
          }
        }
      }
    }, false);
  }

  // Initialize iframes for any polis divs that don't have them
  document.querySelectorAll('.polis').forEach(function(div) {
    if (!div.children?.length) {
      createPolisIframe(div, getConfig(div));
    }
  });
}());
