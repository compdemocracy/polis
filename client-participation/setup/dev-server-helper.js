/**
 * Development server helper functions
 * This module helps fetch conversation data for the development environment
 */

/**
 * Fetches conversation data from the API server
 * @param {string} conversationId - The conversation ID to fetch
 * @param {string} apiBaseUrl - The base URL of the API server
 * @returns {Promise<Object>} - The conversation data
 */
async function fetchConversationData(conversationId, apiBaseUrl = process.env.API_URL) {
  try {
    console.log(`[Dev Helper] Attempting to fetch conversation data for ID: ${conversationId}`);
    console.log(`[Dev Helper] API Base URL: ${apiBaseUrl}`);

    const url = `${apiBaseUrl}/api/v3/participationInit?conversation_id=${conversationId}&pid=-1&lang=acceptLang`;
    console.log(`[Dev Helper] Full URL: ${url}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });

    if (!response.ok && response.status !== 304) {
      console.warn(`[Dev Helper] API responded with ${response.status} ${response.statusText}`);

      // Try to get the error response body
      let errorBody = "";
      try {
        errorBody = await response.text();
        console.warn(`[Dev Helper] Error response body:`, errorBody);
      } catch (e) {
        console.warn(`[Dev Helper] Could not read error response body`);
      }

      // Return mock data for development
      console.log(`[Dev Helper] Using mock data for development`);
      return createMockConversationData(conversationId);
    }

    const data = await response.json();
    console.log(`[Dev Helper] Successfully fetched conversation data`);
    return data;
  } catch (error) {
    console.warn(`[Dev Helper] Failed to fetch conversation data:`, error.message);
    console.log(`[Dev Helper] This is normal if the backend server is not running`);
    console.log(`[Dev Helper] Using mock data for development`);

    // Return mock data for development
    return createMockConversationData(conversationId);
  }
}

/**
 * Creates mock conversation data for development when the backend is not available
 * @param {string} conversationId - The conversation ID
 * @returns {Object} - Mock conversation data
 */
function createMockConversationData(conversationId) {
  return {
    conversation: {
      conversation_id: conversationId,
      topic: "Development Conversation",
      description: "This is mock data for development when the backend server is not available.",
      is_active: true,
      is_draft: false,
      participant_count: 5,
      bgcolor: null,
      help_type: 1,
      vis_type: 0,
      write_type: 0,
      owner: 1,
      created: Date.now() - 86400000, // 1 day ago
      modified: Date.now()
    },
    user: null, // Anonymous user
    ptpt: null, // No participant record yet
    votes: [], // No votes yet
    nextComment: {
      conversation_id: conversationId,
      txt: "This is a sample comment for development",
      tid: 1,
      created: Date.now() - 3600000, // 1 hour ago
      tweet_id: null,
      quote_src_url: null,
      is_seed: true,
      is_meta: false
    },
    famous: [], // No famous comments yet
    pca: JSON.stringify({
      // Empty PCA data
      comment_count: 1,
      group_count: 0,
      n: 0
    }),
    acceptLanguage: "en-US"
  };
}

module.exports = {
  fetchConversationData,
  createMockConversationData
};
