config-setup:
	@echo "--- Ensuring path present on remote host for mounting..."
	@docker-machine ssh do "mkdir -p ${PWD}"

config-push: config-setup
	@echo "--- Pushing config from local config/ dir to mounted volume on remote docker-machine..."
	@docker-machine scp --recursive config/ do:${PWD}

config-pull: config-setup
	@echo "--- Pulling config to local config/ dir from mounted volume on remote docker-machine..."
	@docker-machine scp --recursive do:${PWD}/config/ .

config-sync: config-push config-pull
