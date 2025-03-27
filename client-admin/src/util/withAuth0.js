import React from 'react'
import { useAuth0 } from "@auth0/auth0-react";

function withAuth0(Component) {
  return function WrappedComponent(props) {
    const authprops = useAuth0();
    return <Component {...props} {...authprops} />;
  }
}

export default withAuth0;