config-setup:
	@echo "--- Ensuring path present on remote host for mounting..."
	@docker-machine ssh do "mkdir -p ${PWD}"

config-update: config-setup
	@echo "--- Pushing config from local config/ dir to mounted volume on remote docker-machine..."
	@docker-machine scp --recursive config/ do:${PWD}
