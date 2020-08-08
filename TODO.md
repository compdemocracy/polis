finish copying polis.config to schema.yaml

move .polis_s3_creds_client.json, etc. into schema.yaml

# fix this in ./config/copy_config.sh
# repo_egrep="(polisServer.git|polis.git).*(fetch)"
repo_egrep="(polisServer|polis).*(fetch)"

Define build configurations of interest:

local
local-docker-compose
local-docker-compose-s3
digital-ocean-docker-compose
docker-compose-aws
docker-compose-aws-s3


