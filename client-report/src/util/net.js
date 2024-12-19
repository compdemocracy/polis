// // Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import URLs from "./url";

const urlPrefix = URLs.urlPrefix;

function polisAjax(api, data, type) {
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
        .then(response => {
            if (!response.ok) {
                // Handle error responses (e.g., 403)
                console.error("Error:", response.status, response.statusText);
                if (response.status === 403) {
                    // eb.trigger(eb.authNeeded); 
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .catch(error => {
            console.error("Fetch error:", error);
            // Handle fetch errors
            throw error;
        });
}

function polisPost(api, data) {
    return polisAjax(api, data, "POST");
}

function polisGet(api, data) {
    return polisAjax(api, data, "GET");
}

const PolisNet = {
    polisAjax: polisAjax,
    polisPost: polisPost,
    polisGet: polisGet,
};

export default PolisNet;

