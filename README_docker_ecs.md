# steps for docker ecs:
1. setup aws
1. make sure your aws supports "long arns"
    1. https://github.com/docker/ecs-plugin/issues/175
1. install docker edge
1. setup DockerHubToken
1. docker ecs setup
1. make sure you are using the right docker context:
    1. `docker context list`
    1. `docker context use`
1. follow [steps](https://github.com/docker/ecs-plugin/tree/master/example)


