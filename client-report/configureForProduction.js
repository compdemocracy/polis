const staticFilesPrefix = "cached";
let destRootBase = "devel";
let destRootRest = "/"; // in dist, will be the cachebuster path prefix
let versionString = "VERSION_ERROR";

function getGitHash() {
  if (process.env.GIT_HASH) {
    return process.env.GIT_HASH;
  } else {
    console.warn("No GIT_HASH provided. Skipping use.");
  }
}

// Calculate the git hash and set the destRootRest and versionString variables.
function configureForProduction() {
  destRootBase = "dist";

  let hash = getGitHash()

  const d = new Date();
  const tokenParts = [
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ];

  if (hash) {
    hash = hash.toString().match(/[A-Za-z0-9]+/)[0];
    tokenParts.push(hash);
  }

  const unique_token = tokenParts.join("_");
  destRootRest = [staticFilesPrefix, unique_token].join("/");
  versionString = unique_token;

  return {
    destRootBase,
    destRootRest,
    versionString,
  };
}

const result = configureForProduction();

console.log(result);
