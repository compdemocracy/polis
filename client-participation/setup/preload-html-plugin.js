/**
 * Custom webpack plugin to inject preload data into HTML
 */
const { fetchConversationData } = require("./dev-server-helper");

class PreloadHtmlPlugin {
  constructor(options) {
    this.options = options || {};
    this.conversationId = options.conversationId;
    this.apiUrl = options.apiUrl;
    this.isTest = options.isTest;
  }

  apply(compiler) {
    // Hook into the html-webpack-plugin processing
    compiler.hooks.compilation.tap("PreloadHtmlPlugin", (compilation) => {
      // Get the hooks from HtmlWebpackPlugin
      const hooks = require("html-webpack-plugin").getHooks(compilation);

      // Hook into the html-webpack-plugin before-emit event
      hooks.beforeEmit.tapAsync("PreloadHtmlPlugin", async (htmlPluginData, callback) => {
        try {
          if (!this.conversationId) {
            return callback(null, htmlPluginData);
          }

          let data;
          if (this.isTest) {
            console.log("Loading test data (placeholder for client-participation)");
            // For now, we'll use empty data in test mode
            // TODO: Create test fixtures if needed
            data = {};
          } else {
            console.log(`Fetching conversation data for ID: ${this.conversationId} from ${this.apiUrl}`);
            // Fetch the data using participationInit endpoint
            data = await fetchConversationData(this.conversationId, this.apiUrl);
          }
          console.log("🔄 Fetched conversation data:", Object.keys(data).length > 0 ? "Success" : "Empty");

          if (data && Object.keys(data).length > 0) {
            // Find and replace the original preload assignment directly
            const placeholderPattern = /window\.preload = "REPLACE_THIS_WITH_PRELOAD_DATA";/;

            if (placeholderPattern.test(htmlPluginData.html)) {
              // Replace the placeholder directly with our data
              // Use JSON.stringify for proper escaping but with indentation for readability
              const jsonData = JSON.stringify(data, null, 2);

              // Add some debug logging to make it easier to see what's happening
              htmlPluginData.html = htmlPluginData.html.replace(
                placeholderPattern,
                `window.preload = ${jsonData};\n` +
                  `      console.log("[Development] Preload data loaded for conversation: ${this.conversationId}");` +
                  `\n      console.log("[Development] Preload data:", window.preload);`
              );

              console.log(`✅ Successfully injected preload data for conversation: ${this.conversationId}`);
            } else {
              console.error("❌ Could not find preload placeholder in HTML template");
            }
          } else {
            console.log("⚠️  No conversation data available, keeping placeholder");
          }
        } catch (error) {
          console.error("Failed to inject preload data:", error);
        }

        callback(null, htmlPluginData);
      });
    });
  }
}

module.exports = PreloadHtmlPlugin;
