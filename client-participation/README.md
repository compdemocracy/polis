Polis Client/Participation View
===============================

This is the code for the view that conversation participants see.


Development
-----------

Install with [npm](https://www.npmsjs.org/) and [bower](http://bower.io/) (`npm install --global bower`):

```sh
npm install
bower install
```

There is a `polis.config.template.js` file which will have to be copied over to `polis.config.js`, and edited as appropriate.

To run: `./x`

The dev server should now be running at [localhost:5001](http://localhost:5001/) (or whatever port you set in your `polis.config.js`)
So... you might think that you should now be able to go to this address and see the polis interface.
However, this is not the case.
Because of preprocessing required of the `index.html` file before it will load (including the embedding of the initial data payload in the html), it is necessary that the application be accessed through a running instance of the your [polisServer](https://github.com/pol-is/polisServer) (by default [localhost:5000](http://localhost:5000)).

Also note that the polisServer process will need to know via its config the port on which this, the participation client code, will be available.
If you don't mess with any of the default port settings you shouldn't have to worry about all this nonsense.
Just know that if you do, you will then need to update these port variables in multiple places.



Troubleshooting
---------------

If you get an error running `./x` that looks something like `Error: watch /home/csmall/code/polisClientParticipation/js ENOSPC` trying to run, this may be because your system has too many watches active.
If you see this, try running `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p` to increase the number of available watches on your system.


Deployment
----------

Before pushing to s3: `gulp dist`

Then use the `deployToPreprod` script to deploy to your preprod server to test.
Then `deploy_TO_PRODUCTION` when you are ready.


### Other Requirements

For gulp-ruby-sass to enable `sourcemap` options, it requires Sass >= 3.3.0

