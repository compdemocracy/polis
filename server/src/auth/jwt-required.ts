import { jwtValidation } from "./jwt-middleware";
import { extractUserFromJWT } from "./jwt-middleware";
import { assignToP } from "../utils/parameter";

// This middleware pipeline will first validate the JWT,
// then extract the user information from it.
// It provides a strict, JWT-only authentication mechanism.
export const jwtAuthRequired = [jwtValidation, extractUserFromJWT(assignToP)];
