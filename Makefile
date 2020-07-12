config-push:
	@echo "--- Pushing config from local config/ dir to mounted volume on remote docker-machine..."
	docker-machine scp --recursive config/ do:${PWD}

config-pull:
	@echo "--- Pulling config to local config/ dir from mounted volume on remote docker-machine..."
	docker-machine scp --recursive do:${PWD}/config/ .

config-sync: config-push config-pull
