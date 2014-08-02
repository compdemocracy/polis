# Polis

We are creating a magical portal that allows people to communicate with each other across oceans. Lots of people. We just keep telling ourselves that. -- Mike


## Getting development env running

First get [polis-dashboard-require](https://github.com/colinmegill/polis-dashboard-require); basically the clientside code

    hub clone colinmegill/polis-dashboard-require

Now set up all the js dev stuff you'll need.
These instructions assume you already have node and npm installed.
If you're on Ubuntu, there is a nice up to date ppa you can add (though I don't remember which).
The standard `sudo apt-get install node nodejs npm` may work, but it's a bit older so no guarantees.
And if you're on OSX I have no clue.
If you're running Windows, go home.
Anyway,

    # You will also need ruby's sass installed, though you may need sudo here if you have a system wide ruby (I use RVM)
    gen install sass

    # Now for the npm things
    sudo npm install -g gulp
    sudo npm install -g handlebars
    sudo npm install --save-dev handlebars
    sudo npm install -g bower

    cd polis-dashboard-require
    npm install --save-dev handlebars

    npm install
    bower install
    gulp

    npm install
    gulp
    vim js/views/create-conversation-form.js
    gulp
    vim js/views/conversationGatekeeperView.js
    gulp

Now you should be able to go to <localhost:8000> or <localhost:8000/2demo> and see things.

## Now time to install the server code (in case you want to develop from that)

There will be some extra work here if you don't have a postgres env set up.
If you have Ubuntu you may just be able to install the dev, server and client packages from aptitude.
Not sure on OSX.
Again, go home MS.

Also, make sure you have foreman and heroku tools installed

    wget -qO- https://toolbelt.heroku.com/install-ubuntu.sh | sh
    heroku login

Now you can get the code and install app deps

    cd ..
    hub clone colinmegill/polis
    cd polis
    npm install

You should add the following lines to `.git/config`.
This will let you have access to the GH DB credentials in the eval below.

[remote "heroku"]
    url = git@heroku.com:polisapp.git
    fetch = +refs/heads/*:refs/remotes/heroku/*

And now put it together

    eval `./bin/herokuConfigExport`
    ./x

And now you should be able to go to <localhost:5000> and see some things.

## WIP: Still working on a cleaner way of getting the polismath to operate harmoniously in dev mode with these things.
