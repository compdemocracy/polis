. ${NVM_DIR}/nvm.sh
[ -e ./.env_dev ] && . ./.env_dev
nvm run `node ./bin/printNodeVersion` dev-server.js
