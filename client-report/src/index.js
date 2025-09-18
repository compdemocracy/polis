// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// React Core
import React from "react";
import { AuthProvider } from "react-oidc-context";
import { WebStorageStateStore } from 'oidc-client-ts';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from "./components/app.jsx";
import { datadogRum } from '@datadog/browser-rum';

const ddApplicationId = process.env.DD_APPLICATION_ID;
const ddClientToken = process.env.DD_CLIENT_TOKEN;
const ddSite = process.env.DD_SITE;

const useDatadog = ddApplicationId && ddClientToken && ddSite;

if (useDatadog) {
  datadogRum.init({
    applicationId: ddApplicationId,
    clientToken: ddClientToken,
    site: ddSite,
    service: 'client-report',
    env: 'prod',
    version: '1.0.0',
    sessionSampleRate: 100,
    sessionReplaySampleRate: 20,
    trackBfcacheViews: true,
    defaultPrivacyLevel: 'allow',
  });
}

class Root extends React.Component {
  render() {
    const authority = process.env.AUTH_ISSUER;
    const clientId = process.env.AUTH_CLIENT_ID;
    const audience = process.env.AUTH_AUDIENCE;
    const redirectUri = window.location.origin;

    if (!authority || !clientId || !audience) {
      console.error('OIDC configuration is incomplete. Please check environment variables:');
      console.error('AUTH_ISSUER:', process.env.AUTH_ISSUER);
      console.error('AUTH_CLIENT_ID:', clientId);
      console.error('AUTH_AUDIENCE:', audience);
      return <div>OIDC configuration is required</div>;
    }

    const oidcConfig = {
      authority,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      extraQueryParams: { audience },
    };

    return process.env.AUTH_CLIENT_ID ? (
      <AuthProvider {...oidcConfig}>
        <App />
      </AuthProvider>
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
