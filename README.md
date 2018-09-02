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

If you get an error like `Error: watch /home/csmall/code/polisClientParticipation/js ENOSPC` trying to run, this may be because your system has too many watches active.
If you see this, try running `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p` to increase the number of available watches on your system.



Deployment
----------

Before pushing to s3: `gulp dist`


### Other Requirements

For gulp-ruby-sass to enable `sourcemap` options, it requires Sass >= 3.3.0

