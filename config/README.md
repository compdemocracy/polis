# Configuration files and variables for polis
* Currently, configuration variables live in many different files. 
* The goal is to use [`node-convict`](https://github.com/mozilla/node-convict) to manage configurations
* The defaults for all variables in `config/schema.yaml` are currently for development builds.
* Configurations for backend services (e.g. `server` & `math` are mounted onto a docker volume (`/app/config`) so that they can be updated and reread without a full restart.
    - Resolved configuration variables are also written to `export_config.json` so that they can be easily used by `clojure`, `python`, etc. 
* Configurations for front-end services (e.g. `client-admin`, `client-participation` & `client-report`) are copied into each directory with the `config/copy_config.sh` script. Running `make init` in the root directory will install a git hook that will automatically run `config/copy_config.sh` before each commit. 
* Some config variables seem to be redundant and will be merged later:
    -  `primary_polis_url` & `SERVICE_URL`
* Some config variables can not be easily be managed by `node-convict`:
    - `GIT_HASH`


