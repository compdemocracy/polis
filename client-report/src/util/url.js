// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Determine where to send API requests.
//
// If client-report is running on localhost:5010, it is running via webpack-dev-server,
// and should send requests to localhost:5000. (Dev API server)
//
// If client-report is running on localhost:5000, it is being served by the dev api server,
// and should send requests to localhost:5000. (Dev API server)
//
// If client-report is running on localhost:80, it is being served by the dev api server,
// via nginx-proxy, and should send requests to localhost:80. (Dev API server via nginx-proxy).
//
// If client-report is running on any polis production domain,
// it should send requests to that domain.
//
// Otherwise, use the SERVICE_URL environment variable, if set, or default to
// the current self.origin (e.g. "https://mypolis.xyz/").

// NOTE: SERVICE_URL is currently not present in the production build via gulp.
// It is only present in the dev build via webpack-dev-server.
const serviceUrl = process.env.SERVICE_URL;
const domain = document.domain;
const port = document.location.port;

const getDomainPrefix = () => {
  if (domain === "localhost") {
    if (port === "" || port === "80") return "http://localhost/";
    if (port === "5010") return "http://localhost:5000/";
    return "http://localhost:5000/";
  }

  if (domain.includes("pol.is")) return `https://${domain}/`;
  if (domain.includes("polis.io")) return `https://${domain}/`;

  if (serviceUrl) return `${serviceUrl}/`;

  return `${self.origin}/`;
};

const urlPrefix = getDomainPrefix();

export default { urlPrefix };
