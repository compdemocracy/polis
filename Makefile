## Examples:
# make start                      - runs against main development `.env` file
# make PROD start                 - runs against `prod.env` config file
# make TEST e2e                   - runs tests
# make ENV_FILE=custom.env start  - runs against parameters in `custom.env` config file
# make build-web-assets           - build and extract web assets

SHELL=/bin/bash
E2E_RUN = cd e2e;

define parse_env_value
$(shell grep -e ^$(1) ${ENV_FILE} | awk -F'[=]' '{gsub(/ /,"");print $$2}')
endef

define parse_env_bool
$(if $(filter false,$(1)),false,true)
endef

# Default environment and settings (dev)
export ENV_FILE = .env
export TAG = $(call parse_env_value,TAG)
export GIT_HASH = $(shell git rev-parse --short HEAD)
POSTGRES_DOCKER_RAW = $(shell echo $(call parse_env_value,POSTGRES_DOCKER) | tr '[:upper:]' '[:lower:]')
export POSTGRES_DOCKER = $(call parse_env_bool,$(POSTGRES_DOCKER_RAW))

# Default compose file args
export COMPOSE_FILE_ARGS = -f docker-compose.yml -f docker-compose.dev.yml
COMPOSE_FILE_ARGS += $(if $(POSTGRES_DOCKER),--profile postgres,)

# Set up environment-specific values
define setup_env
	$(eval ENV_FILE = $(1))
	$(eval TAG = $(call parse_env_value,TAG))
	$(eval POSTGRES_DOCKER_RAW = $(shell echo $(call parse_env_value,POSTGRES_DOCKER) | tr '[:upper:]' '[:lower:]'))
	$(eval POSTGRES_DOCKER = $(call parse_env_bool,$(POSTGRES_DOCKER_RAW)))
	$(eval COMPOSE_FILE_ARGS = $(2))
	$(eval COMPOSE_FILE_ARGS += $(if $(POSTGRES_DOCKER),--profile postgres,))
endef

PROD:
	$(call setup_env,prod.env,-f docker-compose.yml)

TEST:
	$(call setup_env,test.env,-f docker-compose.yml -f docker-compose.test.yml)

echo_vars:
	@echo ENV_FILE=${ENV_FILE}
	@echo POSTGRES_DOCKER=${POSTGRES_DOCKER}
	@echo TAG=${TAG}

pull: echo_vars ## Pull most recent Docker container builds (nightlies)
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} pull

start: echo_vars ## Start all Docker containers
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} up

stop: echo_vars ## Stop all Docker containers
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} down

rm-containers: echo_vars ## Remove Docker containers where (polis_tag="${TAG}")
	@echo 'removing filtered containers (polis_tag="${TAG}")'
	@-docker rm -f $(shell docker ps -aq --filter "label=polis_tag=${TAG}")

rm-volumes: echo_vars ## Remove Docker volumes where (polis_tag="${TAG}")
	@echo 'removing filtered volumes (polis_tag="${TAG}")'
	@-docker volume rm -f $(shell docker volume ls -q --filter "label=polis_tag=${TAG}")

rm-images: echo_vars ## Remove Docker images where (polis_tag="${TAG}")
	@echo 'removing filtered images (polis_tag="${TAG}")'
	@-docker rmi -f $(shell docker images -q --filter "label=polis_tag=${TAG}")

rm-ALL: rm-containers rm-volumes rm-images ## Remove Docker containers, volumes, and images (including db) where (polis_tag="${TAG}")
	@echo Done.

hash: ## Show current short hash
	@echo Git hash: ${GIT_HASH}

build: echo_vars ## [Re]Build all Docker containers
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} build

build-no-cache: echo_vars ## Build all Docker containers without cache
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} build --no-cache

start-recreate: echo_vars ## Start all Docker containers with recreated environments
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} up --force-recreate

start-rebuild: echo_vars ## Start all Docker containers, [re]building as needed
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} up --build

start-FULL-REBUILD: echo_vars stop rm-ALL ## Remove and restart all Docker containers, volumes, and images (including db), as with rm-ALL
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} build --no-cache
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} down
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} up --build
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} down
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} up --build

build-web-assets: ## Build and extract static web assets for cloud deployment to `build` dir
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} create --build --force-recreate file-server
	$(MAKE) extract-web-assets

extract-web-assets: ## Extract static web assets from file-server to `build` dir
	/bin/rm -rf build
	docker compose ${COMPOSE_FILE_ARGS} --env-file ${ENV_FILE} cp file-server:/app/build/ build

e2e-install: e2e/node_modules ## Install Cypress E2E testing tools
	$(E2E_RUN) npm install

e2e-run: ## Run E2E tests except those which require 3rd party services
	$(E2E_RUN) npm run test

e2e-run-all: ## Run E2E tests: all
	$(E2E_RUN) npm run test:all

e2e-run-interactive: ## Run E2E tests: interactively
	$(E2E_RUN) npx cypress open

# Helpful CLI shortcuts
rbs: start-rebuild

%:
	@true

.PHONY: help pull start stop rm-containers rm-volumes rm-images rm-ALL hash build-no-cache start-rebuild \
	start-recreate restart-FULL-REBUILD e2e-install e2e-run e2e-run-all e2e-run-interactive \
	build-web-assets extract-web-assets


help:
	@echo 'Usage: make <command>'
	@echo
	@echo 'where <command> can be one or more of the following:'
	@echo
	@grep -E '^[a-z0-9A-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo 'By default, runs against the configuration specified in `.env` file (see `example.env` for a template).'
	@echo
	@echo 'As specified above, the config file can be overridden using `PROD` or `TEST` commands, and a custom config file'
	@echo 'can also be specified by explicitly setting the `ENV_FILE` variable, like: `make ENV_FILE=custom.env <command>`.'
	@echo
	@echo 'Note that different values of `TAG` specified in your config file will result in different container and asset'
	@echo 'builds, which can be useful for (e.g.) testing out features while preserving mainline branch builds.'

.DEFAULT_GOAL := help
