.PHONY: start start-debug stop clean 

start:
	@echo "--- Running 'docker-compose up --build -d'..."
	GIT_HASH=`git log --pretty="%h" -n 1`  docker-compose up --build -d

start-debug:
	@echo "--- Running 'docker-compose --log-level DEBUG --verbose up --build -d'..."
	GIT_HASH=`git log --pretty="%h" -n 1`  docker-compose --log-level DEBUG --verbose up --build -d

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


