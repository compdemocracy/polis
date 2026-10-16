interface DeregisterRequest {
  p?: { showPage?: any };
}

interface DeregisterResponse {
  status: (code: number) => {
    json: (data: any) => void;
  };
}

/**
 * JWT-based logout handler
 * With JWTs, logout is primarily a client-side operation.
 * The server doesn't need to track sessions or clear cookies.
 */
function handle_POST_auth_deregister_jwt(
  req: DeregisterRequest,
  res: DeregisterResponse
): void {
  // With JWT auth, the server doesn't need to do anything
  // The client is responsible for:
  // 1. Removing the JWT from localStorage/memory
  // 2. Optionally calling OIDC logout endpoint

  res.status(200).json({
    status: "success",
    message: "Logout successful. Please remove your JWT token.",
  });
}

export { handle_POST_auth_deregister_jwt };
