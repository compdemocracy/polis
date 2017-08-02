. ${NVM_DIR}/nvm.sh
# export NODE_ENV=development
. ./.env_always
BABEL_ENV=development nvm run `node ./bin/printNodeVersion` gulpfile.js default
