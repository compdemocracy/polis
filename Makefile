$SUDO.PHONY: start start-debug stop clean

# $SUDO is an optional shell variable which can be set to "sudo" if needed
# (for example, on an ec2 instance)

start:
	@echo "--- Running 'docker-compose up --build -d'..."
	GIT_HASH=`git log --pretty="%h" -n 1` $SUDO docker-compose up --build -d

start-debug:
	@echo "--- Running 'docker-compose --log-level DEBUG --verbose up --build -d'..."
	GIT_HASH=`git log --pretty="%h" -n 1` $SUDO docker-compose --log-level DEBUG --verbose up --build -d

stop:
	@echo "--- Running 'docker-compose kill/rm/prune'..."
	$SUDO docker-compose kill
	$SUDO docker-compose rm -f
	$SUDO docker system prune --volumes -f

clean:
	@echo "--- Copy and past the following commands..."
	@echo 'docker rm -f $$(docker ps -aq)'
	@echo 'docker rmi -f $$(docker images -q)'
	@echo 'docker system prune --volumes -f'
	@echo 'echo done'


