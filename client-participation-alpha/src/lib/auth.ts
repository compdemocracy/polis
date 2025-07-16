/**
 * Decodes a JWT from localStorage without verifying its signature.
 *
 * @param {string} key The localStorage key where the JWT is stored.
 * @returns {object|null} The decoded JWT payload as an object, or null if the token is not found or invalid.
 */
export function getJwtPayload(key: string) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    const jwt = localStorage.getItem(key);

    if (!jwt) {
      return null;
    }
    const payloadBase64 = jwt.split('.')[1];
    if (!payloadBase64) {
      return null;
    }

    const jsonPayload = atob(payloadBase64);
    return JSON.parse(jsonPayload);

  } catch (error) {
    console.error("Failed to decode JWT:", error);
    return null;
  }
}
