"use strict";

// Encode only filesystem names; case IDs and recording contents stay unchanged.
// decodeURIComponent reverses this mapping, including literal percent escapes.
function artifactDirectory(name) {
  return encodeURIComponent(name).replace(/[.!'()*]/g, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase()
  );
}

module.exports = { artifactDirectory };
