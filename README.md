Polis Client/Participation View
===============================

This is the code for the view that conversation participants see.


Development
-----------

Install with [npm](https://www.npmsjs.org/) and [bower](http://bower.io/):

```sh
npm install
bower install
```

To build: `gulp`

The dev server is at [localhost:8000](http://localhost:8000/)


Deployment
----------

There is a `polis.config.template.js` file which will have to be copied over to `polis.config.js`, and edited as appropriate.

Before pushing to s3: `gulp dist`


### Other Requirements

For gulp-ruby-sass to enable `sourcemap` options, it requires Sass >= 3.3.0

