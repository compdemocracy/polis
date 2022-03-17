# Configuration files and variables for polis
* Currently, configuration variables live in many different files. 
* The goal is to use [`node-convict`](https://github.com/mozilla/node-convict) to manage configurations
* The defaults for all variables in `config/schema.yaml` are currently for development builds.
* Configurations for backend services (e.g. `server` & `math` are mounted onto a docker volume (`/app/config`) so that they can be updated and reread without a full restart.
    - Resolved configuration variables are also written to `export_config.json` so that they can be easily used by `clojure`, `python`, etc. 
* Some config variables seem to be redundant and will be merged later:
    -  `primary_polis_url` & `SERVICE_URL`
* Some config variables can not be easily be managed by `node-convict`:
    - `GIT_HASH`
* Note: `sort_flat_config_yaml_file.py` will sort keys and check for duplicates.
* @TODO:
    - Write code to read json config into math
