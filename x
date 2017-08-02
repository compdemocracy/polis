. ${NVM_DIR}/nvm.sh
. ./.env_always
. ./.env_dev
nvm run `node ./bin/printNodeVersion` dev-server.js
