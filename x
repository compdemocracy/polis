. ~/.nvm/nvm.sh
. ./.env_dev
eslint *.js && nvm run `node bin/printNodeVersion` --max_old_space_size=400 --gc_interval=100 --harmony app.js
