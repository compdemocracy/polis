// // Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import URLs from "./url";

const urlPrefix = URLs.urlPrefix;

function polisAjax(api, data, type, token) {
    if (typeof api !== "string") {
        throw "api param should be a string";
    }

    if (api && api.length && api[0] === '/') {
        api = api.slice(1);
    }

    let url = urlPrefix + api;

    const options = {
        method: type,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "max-age=0",
            ...(token && {"Authorization": `Bearer ${token}`})
        },
        credentials: "include", // This sends cookies with the request
    };

    if (type === "POST") {
        options.body = JSON.stringify(data);
    } else if (type === "GET" && data) {
        // Add data as query parameters for GET requests
        const queryParams = new URLSearchParams(data);
        url += `?${queryParams}`;
    }

    return fetch(url, options)
        .then(async response => {
            // Handle 304 Not Modified - return empty array for consistency
            if (response.status === 304) {
                return []; // Return empty array for 304 responses
            }
            
            if (!response.ok) {
                // Handle error responses (e.g., 403)
                console.error("Error:", response.status, response.statusText);
                if (response.status === 403) {
                    // eb.trigger(eb.authNeeded); 
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            // Check if there's actually a body to parse
            const contentLength = response.headers.get('content-length');
            
            // If no content or content-length is 0, return empty array
            if (contentLength === '0' || !response.body) {
                return [];
            }
            
            // Try to parse JSON, but handle empty responses gracefully
            try {
                const text = await response.text();
                
                if (!text || text.trim() === '') {
                    return [];
                }
                
                const data = JSON.parse(text);
                return data;
            } catch (jsonError) {
                console.error('JSON parse error:', jsonError);
                console.error('Failed to parse response as JSON');
                // For non-JSON responses, return empty array to avoid breaking the app
                return [];
            }
        })
        .catch(error => {
            console.error("Fetch error:", error);
            // Handle fetch errors
            throw error;
        });
}

function polisPost(api, data, token) {
    return polisAjax(api, data, "POST", token);
}

function polisGet(api, data, token) {
    return polisAjax(api, data, "GET", token);
}

const PolisNet = {
    polisAjax: polisAjax,
    polisPost: polisPost,
    polisGet: polisGet,
};

export default PolisNet;
