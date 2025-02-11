# Examples:
# make test-clj           - runs all Clojure tests in the docker container
# make test-clj T=utils   - runs only utils-test in the docker container
# make test-py           - runs Python tests on the host
# make test              - runs both Clojure and Python tests

SHELL=/bin/bash

.PHONY: test test-clj test-py help

test-clj: ## Run Clojure tests in the docker container. Optional: T=test_name (without -test suffix), ARGS="additional arguments"
	@echo "Running Clojure tests..."
ifdef T
	docker exec -it polis-dev-math-1 clojure -M:test $(T) --coverage $(ARGS)
else
	docker exec -it polis-dev-math-1 clojure -M:test --coverage $(ARGS)
endif
test-py: ## Run Python tests on the host machine
	@echo "Running Python tests..."
	cd $(CURDIR) && python -m pytest pythonport/test_*.py -v --cov=pythonport --cov-report=term-missing --capture=no

test: test-clj test-py ## Run both Clojure and Python tests
	@echo "All tests completed."

update-from-scratch: ### Update a single convo
ifdef ZID
	# Note: we will want to find a cleaner way than having an explicit container name here
	# but for now that will have to do as I am not sure enough of the `docker compose run`
	# subtlety. 
	docker exec -it polis-dev-math-1 clojure -M:run update -r -z $(ZID)
else
	docker exec -it polis-dev-math-1 clojure -M:run update -r -z 1
endif

trace: ### Run a single convo with tracing enabled
	docker exec -it polis-dev-math-1 clojure -M:run update-with-trace -r -z 17909

compare-traces: ### Run the traced calls in python and compare with the traced results
ifdef DIR
	python -m pythonport.validate_instrumentation "$(DIR)";
else 
	python -m pythonport.validate_instrumentation "./traces"
endif
	

help: ## Show this help
	@echo 'Usage: make <command>'
	@echo
	@echo 'Available commands:'
	@grep -E '^[a-z0-9A-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo 'For test-clj, you can specify which tests to run with T=test_name'
	@echo 'Example: make test-clj T=utils        # runs only utils-test'
	@echo '         make test-clj T="utils pca"  # runs utils-test and pca-test'
	@echo 'If target unknown, will try and call the root Makefile'

.DEFAULT_GOAL := help 


# If unknown target, try the root Makefile
%:
	@$(MAKE) -C .. $@

.PHONY: test test-clj test-py help update-from-scratch trace compare-traces
