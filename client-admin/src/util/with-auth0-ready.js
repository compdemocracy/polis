// Higher-Order Component to ensure Auth0 is ready before executing API calls
import React from 'react';

function withAuth0Ready(WrappedComponent, onReadyCallback) {
  return class WithAuth0Ready extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        auth0Ready: false
      };
      this.auth0ReadyHandler = null;
    }

    componentDidMount() {
      // Listen for auth0Ready event to ensure token getter is available
      this.auth0ReadyHandler = (event) => {
        console.log(`📡 ${WrappedComponent.name} received auth0Ready event:`, event.detail);
        this.setState({ auth0Ready: true });
      };
      
      window.addEventListener('auth0Ready', this.auth0ReadyHandler);
      
      // If auth0 is already ready (event fired before this component mounted), 
      // set state immediately
      if (window.auth0Ready) {
        console.log(`🚀 Auth0 was already ready for ${WrappedComponent.name}`);
        this.setState({ auth0Ready: true });
      }
    }

    componentDidUpdate(prevState) {
      // When auth0Ready state changes from false to true, call the callback
      if (!prevState.auth0Ready && this.state.auth0Ready && onReadyCallback) {
        console.log(`🚀 Calling onReady callback for ${WrappedComponent.name}`);
        // Use setTimeout to ensure the wrapped component has had a chance to mount
        setTimeout(() => {
          if (this.wrappedComponentRef) {
            try {
              onReadyCallback.call(this.wrappedComponentRef, this.props);
            } catch (error) {
              console.error(`Error calling onReady callback for ${WrappedComponent.name}:`, error);
              // If calling with 'this' context fails, try calling without context
              try {
                onReadyCallback(this.props);
              } catch (fallbackError) {
                console.error(`Fallback onReady callback also failed for ${WrappedComponent.name}:`, fallbackError);
              }
            }
          }
        }, 0);
      }
    }

    componentWillUnmount() {
      // Clean up event listener
      if (this.auth0ReadyHandler) {
        window.removeEventListener('auth0Ready', this.auth0ReadyHandler);
      }
    }

    render() {
      return (
        <WrappedComponent 
          {...this.props} 
          ref={ref => this.wrappedComponentRef = ref}
          auth0Ready={this.state.auth0Ready}
          onAuth0Ready={onReadyCallback}
        />
      );
    }
  };
}

export default withAuth0Ready; 