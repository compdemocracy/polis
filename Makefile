.PHONY: config start stop clean

config:
	@echo "--- Sending contents of `config/shared/` to named volume `config`..."
	docker-compose up --build config

start:
	@echo "--- Running 'docker-compose up --build -d'..."
	docker-compose up --build -d

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

