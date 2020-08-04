# heroku create
heroku_docker="dgps-polis-docker-test-3"
heroku create ${heroku_docker}
heroku stack:set container
git push heroku master
# need to rename Procfile?
# debug/node-convict-math
heroku_math="dgps-polis-docker-test-math-9"
heroku create ${heroku_math}
git push heroku master

# heroku create
heroku_math="dgps-polis-docker-test-math-3"
heroku_server="dgps-polis-docker-test-serv-2"

cd math
heroku create ${heroku_math}
git push heroku master

# heroku create
heroku_docker="dgps-polis-docker-test-3"
heroku create ${heroku_docker}
heroku stack:set container
git push heroku master

https://medium.com/inato/how-to-setup-heroku-with-yarn-workspaces-d8eac0db0256

https://github.com/heroku/heroku-buildpack-multi-procfile
heroku_math="dgps-polis-docker-test-math-5"
heroku_server="dgps-polis-docker-test-serv-5"
heroku create -a ${heroku_math}
heroku create -a ${heroku_server}
heroku buildpacks:add -a ${heroku_math} https://github.com/heroku/heroku-buildpack-multi-procfile
heroku buildpacks:add -a ${heroku_server} https://github.com/heroku/heroku-buildpack-multi-procfile
heroku config:set -a ${heroku_math} PROCFILE=math/Procfile
heroku config:set -a ${heroku_server} PROCFILE=server/Procfile
git push https://git.heroku.com/${heroku_math}.git HEAD:master
git push https://git.heroku.com/${heroku_server}.git HEAD:master
