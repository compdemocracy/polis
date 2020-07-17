config:
	@echo "--- Sending contents of `config/shared/` to named volume `config`..."
	docker-compose up --build config

start:
	@echo "--- Running `docker-compose up --build -d`..."
	docker-compose up --build -d

stop:
	@echo "--- Running `docker-compose kill/rm/prune`..."
	docker-compose kill
	docker-compose rm -f
	docker system prune --volumes -f
