edit docker-compose

client-report; finish copying polis.config to schema.yaml

rename polisConfig2 polisConfig

fix `grep -e "serviceUrl" -l  */*  2> /dev/null`d

move .polis_s3_creds_client.json, etc. into schema.yaml

Using make command to hide complex command formats like this

Moving the docker context up to root, and then COPY'ing .git/ dir into container, and reading HEAD data from it

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


