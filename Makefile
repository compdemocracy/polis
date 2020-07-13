#
# If your docker-machine is not named "default", then:
#
# 	$ make config-push-remote machine=foo
#

machine ?= default
volume-name := polis_config

config-push-local: ## push config dir to mounted volume (local docker-compose)
	# See: https://github.com/moby/moby/issues/25245#issuecomment-367742567
	@echo "--- Copying config directory contents to mounted volume..."
	docker run --rm -v $$PWD:/source -v $(volume-name):/dest -w /source alpine cp -r config/* /dest

config-push-remote: ## push config dir to mounted volume (remote docker-compose via docker-machine)
	@echo "--- Copying config directory contents to remote server..."
	docker-machine scp --recursive config $(machine):./
	@echo "--- Copying config directory contents to mounted volume..."
	docker-machine ssh $(machine) 'docker run --rm -v $$PWD:/source -v $(volume-name):/dest -w /source alpine cp -r config/* /dest'
