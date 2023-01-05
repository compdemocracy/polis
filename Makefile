## TTD:
# make start; make stop
# make PROD start; make PROD stop
# update TAG

SHELL=/bin/bash

BASEURL ?= https://127.0.0.1.sslip.io
E2E_RUN = cd e2e; CYPRESS_BASE_URL=$(BASEURL)
export ENV_FILE = .env

export GIT_HASH := $(shell git rev-parse --short HEAD)

ifeq "$(origin TAG)" "undefined"
	TAG := $(shell source $(ENV_FILE); echo $$TAG)
endif
export TAG

PROD: ## Use with prod environment (use make PROD pull, etc.)
	$(eval ENV_FILE = prod.env)
	ifeq "$(origin TAG)" "undefined"
		TAG := $(shell source $(ENV_FILE); echo $$TAG)
	endif
	export TAG

pull: ## Pull most recent Docker container builds (nightlies)
	docker-compose --env-file ${ENV_FILE} pull

start: ## Start all Docker containers
	docker-compose --env-file ${ENV_FILE} up

stop: ## Stop all Docker containers
	docker-compose --env-file ${ENV_FILE} down

rm-containers: ## Remove Docker containers where (polis_tag="${TAG}")
	@echo 'removing filtered containers (polis_tag="${TAG}")'
	@-docker rm -f $(shell docker ps -aq --filter "label=polis_tag=${TAG}")

rm-volumes: ## Remove Docker volumes where (polis_tag="${TAG}")
	@echo 'removing filtered volumes (polis_tag="${TAG}")'
	@-docker volume rm -f $(shell docker volume ls -q --filter "label=polis_tag=${TAG}")

rm-images: ## Remove Docker images where (polis_tag="${TAG}")
	@echo 'removing filtered images (polis_tag="${TAG}")'
	@-docker rmi -f $(shell docker images -q --filter "label=polis_tag=${TAG}")

rm-ALL: rm-containers rm-volumes rm-images ## Remove Docker containers, volumes, and images where (polis_tag="${TAG}")
	@echo Done.

rm-ALL-ALL-TAGS: ## Remove EVERY Docker container, volume, and image on this machine
	-docker rm -f $(shell docker ps -aq)
	-docker rmi -f $(shell docker images -q)
	-docker volume rm $(shell docker volume ls -q)

hash: ## Show current short hash
	@echo Git hash: ${GIT_HASH}

start-rebuild: ## Start all Docker containers, [re]building as needed
	docker-compose --env-file ${ENV_FILE} up --build

restart-FULL-REBUILD: stop rm-ALL ## Remove and restart all Docker containers, volumes, and images where (polis_tag="${TAG}")
	docker-compose --env-file ${ENV_FILE} build --no-cache
	docker-compose --env-file ${ENV_FILE} down
	docker-compose --env-file ${ENV_FILE} up --build
	docker-compose --env-file ${ENV_FILE} down
	docker-compose --env-file ${ENV_FILE} up --build

e2e-install: e2e/node_modules ## Install Cypress E2E testing tools
	$(E2E_RUN) npm install

e2e-prepare: ## Prepare to run Cypress E2E tests
	@# Testing embeds requires a override of a file prior to build.
	cp e2e/cypress/fixtures/html/embed.html client-admin/embed.html

e2e-run-minimal: ## Run E2E tests: minimal (smoke test)
	$(E2E_RUN) npm run e2e:minimal

e2e-run-standalone: ## Run E2E tests: standalone (no credentials required)
	$(E2E_RUN) npm run e2e:standalone

e2e-run-secret: ## Run E2E tests: secret (credentials required)
	$(E2E_RUN) npm run e2e:secret

e2e-run-subset: ## Run E2E tests: filter tests by TEST_FILTER envvar (without browser exit)
	$(E2E_RUN) npm run e2e:subset

e2e-run-all: ## Run E2E tests: all
	$(E2E_RUN) npm run e2e:all


# Helpful CLI shortcuts
rbs: start-rebuild

%:
	@true

.PHONY: help pull start stop rm-containers rm-volumes rm-images rm-ALL hash start-rebuild restart-FULL-REBUILD \
	rm-ALL-ALL-TAGS e2e-install e2e-prepare e2e-run-minimal e2e-run-standalone e2e-run-secret e2e-run-subset e2e-run-all

help:
	@echo 'Usage: make <command>'
	@echo
	@echo 'where <command> is one of the following:'
	@echo
	@grep -E '^[a-z0-9A-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
