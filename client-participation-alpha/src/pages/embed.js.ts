import type { APIRoute } from 'astro';

/**
 *  usage - 
 * <div class='polis' data-conversation_id='9hhmb5fufv'></div>
 * <script async src="https://pol.is/alpha/embed.js"></script>
 * 
 *  */
const embedScriptTemplate = `
/**
 * Polis Embed Script
 */
(function() {
  const EMBED_SERVICE_HOSTNAME = "__HOSTNAME__";
  const polis = (window.polis = window.polis || {});
  if (polis._hasRun) {
    return;
  }
  polis._hasRun = true;

  const serviceUrl = \`\${window.location.protocol}//\${EMBED_SERVICE_HOSTNAME}\`;
  const maxHeightsSeen = {};

  // Initialize the event bus for external integrations
  polis.on = polis.on || {};
  polis.on.vote = polis.on.vote || [];
  polis.on.doneVoting = polis.on.doneVoting || [];
  polis.on.write = polis.on.write || [];
  polis.on.resize = polis.on.resize || [];
  polis.on.init = polis.on.init || [];

  function getConfig(element) {
    const data = element.dataset;
    return {
      conversation_id: data.conversation_id,
      xid: data.xid,
      x_name: data.x_name,
      x_profile_image_url: data.x_profile_image_url,
      height: data.height,
      border: data.border,
      border_radius: data.border_radius,
      padding: data.padding,
      ui_lang: data.ui_lang,
      topic: data.topic,
      auth_needed_to_vote: data.auth_needed_to_vote,
      auth_needed_to_write: data.auth_needed_to_write,
    };
  }

  function createPolisIframe(parentElement, config) {
    if (!config.conversation_id) {
      console.error("Polis: Missing data-conversation_id attribute.");
      return;
    }

    const iframe = document.createElement("iframe");
    const iframeId = \`polis_\${config.conversation_id}\`;
    const baseUrl = \`\${serviceUrl}/alpha/\${config.conversation_id}\`;
    const params = new URLSearchParams();
    params.append("parent_url", window.location.href);
    params.append("referrer", document.referrer);

    ['xid', 'x_name', 'x_profile_image_url', 'ui_lang', 'topic', 'auth_needed_to_vote', 'auth_needed_to_write'].forEach(key => {
      if (config[key]) {
        params.append(key, config[key]);
      }
    });
    
    iframe.src = \`\${baseUrl}?\${params.toString()}\`;
    iframe.id = iframeId;
    iframe.width = "100%";
    iframe.height = config.height || 930;
    iframe.style.border = config.border || "1px solid #ccc";
    iframe.style.borderRadius = config.border_radius || "4px";
    iframe.style.padding = config.padding || "4px";
    iframe.style.backgroundColor = "white";
    iframe.setAttribute("data-test-id", "polis-iframe");

    parentElement.appendChild(iframe);
  }

  function handleIframeMessage(event) {
    const eventDomain = event.origin.replace(/^https?:\\/\\//, "");
    if (eventDomain !== EMBED_SERVICE_HOSTNAME) {
      return;
    }

    const data = event.data || {};
    const eventName = data.name;

    if (eventName && polis.on[eventName]) {
      const iframe = document.getElementById(\`polis_\${data.polisFrameId}\`);
      polis.on[eventName].forEach(callback => {
        try {
          callback({ iframe, data });
        } catch (e) {
          console.error(\`Error in polis.on.\${eventName} callback:\`, e);
        }
      });
    }

    if (eventName === "resize") {
      const frameId = \`polis_\${data.polisFrameId}\`;
      const iframe = document.getElementById(frameId);
      if (iframe) {
        const h = data.height;
        if (!maxHeightsSeen[frameId] || h > maxHeightsSeen[frameId]) {
          maxHeightsSeen[frameId] = h;
          iframe.height = h;
        }
      }
    }
  }

  window.addEventListener("message", handleIframeMessage, false);


  const polisDivs = document.getElementsByClassName("polis");
  for (const div of polisDivs) {
    if (!div.querySelector("iframe")) {
      const config = getConfig(div);
      createPolisIframe(div, config);
    }
  }

}());
`;

export const GET: APIRoute = () => {
  const hostname = import.meta.env.PUBLIC_EMBED_HOSTNAME || 'pol.is';

  if (!hostname) {
    return new Response("Configuration error: EMBED_SERVICE_HOSTNAME is not set.", { status: 500 });
  }

  const finalScript = embedScriptTemplate.replace("__HOSTNAME__", hostname);

  return new Response(finalScript, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
    },
  });
};
