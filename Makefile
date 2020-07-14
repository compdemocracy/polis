config:
	@echo "--- Sending contents of `config/shared/` to named volume `config`..."
	docker-compose up --build config
