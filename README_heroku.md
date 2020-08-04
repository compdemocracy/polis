heroku create
heroku create <name>
heroku stack:set container
git push heroku master
https://medium.com/inato/how-to-setup-heroku-with-yarn-workspaces-d8eac0db0256

https://github.com/heroku/heroku-buildpack-multi-procfile
heroku_math="dgps-polis-docker-test-math-2"
heroku_server="dgps-polis-docker-test-server-2"
heroku create -a ${heroku_math}
heroku create -a ${heroku_server}
heroku buildpacks:add -a ${heroku_math} https://github.com/heroku/heroku-buildpack-multi-procfile
heroku buildpacks:add -a ${heroku_server} https://github.com/heroku/heroku-buildpack-multi-procfile
heroku config:set -a ${heroku_math} PROCFILE=math/Procfile
heroku config:set -a ${heroku_server} PROCFILE=server/Procfile
git push https://git.heroku.com/${heroku_math}.git HEAD:master
git push https://git.heroku.com/${heroku_server}.git HEAD:master
