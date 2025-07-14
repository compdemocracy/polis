// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// React Core
import React from "react";
import { Auth0Provider } from "@auth0/auth0-react";
import { createRoot } from 'react-dom/client';
import './index.css';
import App from "./components/app.jsx";

class Root extends React.Component {
  getDomainFromIssuer(issuer) {
    try {
      // Extract domain from AUTH_ISSUER URL (e.g., "https://localhost:3000/" -> "localhost:3000")
      return new URL(issuer).host;
    } catch (e) {
      console.error('Invalid AUTH_ISSUER', e);
      return null;
    }
  }

  render() {
    const authDomain = this.getDomainFromIssuer(process.env.AUTH_ISSUER);

    if (!authDomain) {
      return <div>Invalid AUTH_ISSUER</div>;
    }

    return process.env.AUTH_CLIENT_ID ? (
      <Auth0Provider
        domain={authDomain}
        clientId={process.env.AUTH_CLIENT_ID}
        authorizationParams={{
          audience: "users",
          redirect_uri: window.location.origin
        }}
      >
        <App />
      </Auth0Provider>
    ) : (
      <div>
        <App />
      </div>
    );
  }
}

const container = document.getElementById("root")
const root = createRoot(container);

root.render(<Root />)
