

# Running Polis with docker machine

If you are unable to run the entire Polis system on your machine through Docker, either because of performance, platform or licensing issues, you can use Docker Machine to run the development environment remotely.
To find out more, visit the Docker Machine project's repository:

https://github.com/docker/machine

Follow the instructions there on how to set up Docker Machine and connect to a hosting provider.
Then:
1. Create a remote docker machine
   1. For AWS, this would look like `docker-machine create --driver amazonec2 --amazonec2-open-port 5000 --amazonec2-region us-east-2 remote-polis`
   1. This creates a machine called `remote-polis`. 
1. Connect your shell to the docker machine: `eval "$(docker-machine env remote-polis)"` 
1. Build and launch the polis server on the remote docker machine: `cd polisServer; docker-compose up`. (Note: the build took ~10 minutes on a default aws machine.)

You should see something like this

```
NAME          ACTIVE   DRIVER       STATE     URL                         SWARM   DOCKER      ERRORS
remote-polis  *        amazonec2    Running   tcp://A.BB.CCC.DDD:EEEE             v19.03.12
```

Next:

1. Find the IP address of the docker machine (A.BB.CCC.DDD above)
1. Visit port 5000 of this IP address (e.g. http://A.BB.CCC.DDD:5000)
1. Useful commands for a remote docker machine:
    1. `docker-machine ls` to see a list of available “machines”.
    2. `docker-machine start <name>` 
    3. `docker-machine stop <name>`
    4. `docker-machine ssh <name>` to open an SSH session to the specified instance.
    5. `docker-machine rm <name>` permanently remove instance. 
1. Remember to stop (`docker-machine stop <name>`) and delete (`docker-machine rm <name>`) remote instance to avoid unwanted charges.


