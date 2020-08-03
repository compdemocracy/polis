.PHONY: init config start stop clean clean-server

init:
	git config core.hooksPath .githooks

config:
	@echo "--- Sending contents of `config/shared/` to named volume `config`..."
	docker-compose up --build config

start:
	@echo "--- Running 'docker-compose up --build -d'..."
	docker-compose up --build -d

start-server:
	@echo "--- Running 'docker-compose up --build -d'..."
	docker-compose up --build -d config
	docker-compose up --build -d server

stop:
	@echo "--- Running 'docker-compose kill/rm/prune'..."
	docker-compose kill
	docker-compose rm -f
	docker system prune --volumes -f

clean:
	@echo "--- Copy and past the following commands..."
	@echo 'docker rm -f $$(docker ps -aq)'
	@echo 'docker rmi -f $$(docker images -q)'
	@echo 'docker system prune --volumes -f'
	@echo 'echo done'

clean-server:
	@echo "docker ps; docker stop <server>; docker image ls"
	@echo "docker image rm -f <server>; docker image prune"

