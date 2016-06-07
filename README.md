polis-dashboard-require
=======================

This is the port of the polis dashboard to use requirejs

Development
-----------

Install with [npm](https://www.npmsjs.org/) and [bower](http://bower.io/):

```sh
npm install
bower install
```

To build: `gulp`

Before pushing to s3: `gulp dist`

The dev server is at [localhost:8000](http://localhost:8000/)

### Requirements

For gulp-ruby-sass to enable `sourcemap` options, it requires Sass >= 3.3.0
