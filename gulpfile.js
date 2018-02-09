// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require('underscore');
var Promise = require('bluebird');
var exec = require('child_process').exec;
var express = require('express');
var gulp = require('gulp');
var s3 = require('gulp-s3');
var browserify = require('gulp-browserify');
var concat = require('gulp-concat');
var isTrue = require('boolean');
var uglify = require('gulp-uglify')
var rename = require('gulp-rename');
var connect = require('gulp-connect');
var tap = require('gulp-tap');
var clean = require('gulp-clean');
var jshint = require('gulp-jshint');
// var glob = Promise.promisify(require('glob'));
var glob = require('glob');
var gzip = require('gulp-gzip');
var template = require('gulp-template');
var watch = require('gulp-watch');
var path = require('path');
var combineCSS = require('combine-css');
var gulpif = require('gulp-if');
var gutil = require('gulp-util');
var handlebars = require('gulp-handlebars');
var compileHandlebars = require('gulp-compile-handlebars');
// var styl = require('gulp-styl');
// var refresh = require('gulp-livereload');
// var lr = require('tiny-lr');
// var server = lr();
var markdown = require('gulp-markdown');
var path = require('path');
var Promise = require('es6-promise').Promise;
var proxy = require('proxy-middleware');
var header = require('gulp-header');
var hbsfy = require("hbsfy").configure({
  extensions: ["handlebars"]
});
var https = require("https");
var fs = require('fs');
var mapStream = require('map-stream');
var request = require('request');
var rimraf = require("rimraf");
var runSequence = require('run-sequence');
var sass = require('gulp-sass');
var scp = require('gulp-scp2');
var spawn = require('child_process').spawn;
var Stream = require('stream');
var sys = require('sys');
var url = require('url');

var polisConfig = require('./polis.config');


console.log("Uploader: " + polisConfig.UPLOADER);

// WARNING: useJsHint gets mutated in watch builds
var useJsHint = true;

const staticFilesPrefix = "cached";
const baseDistRoot = "dist";
var destRootBase = "devel";
var destRootRest = '/';  // in dist, will be the cachebuster path prefix
var versionString = 'VERSION_ERROR';
function destRoot() {
  var root = path.join(destRootBase, destRootRest);
  return root;
}
var devMode = true;
var minified = false;
var scpSubdir = "";
var preprodMode = false;
var prodMode = false;
var host;


var basepath_visbundle_dev = "/foo";

var webpack = require("webpack");
var config = require("./webpack.config.dev");
config.output.publicPath = basepath_visbundle_dev + "/js/";
// console.log(config.output.publicPath);
var compiler = webpack(config);
var webpackStream = require('webpack-stream');


function showDesktopNotification(title, body) {
  if (process.platform !== 'darwin') { return; }
  var child = spawn("osascript", ["-e", 'display notification "'+body+'" with title "'+title+'"'], {cwd: process.cwd()}),
            stdout = '',
            stderr = '';
}


function prepPathForTemplate(path) {
  // add slash at front if missing
  if (path.match(/^[^\/]/)) {
    path = "/" + path;
  }
  path = path.replace(/\/*$/,""); // remove trailing slash
  return path;
}

gulp.task('connect', [], function() {

  function proxyToPreprod(req, response) {
    var x = request("https://preprod.pol.is" + req.originalUrl);
    x.on("error", function(err) {
      response.status(500).end();
    });
    req.pipe(x);
    x.pipe(response);
  }


  express.static.mime.define({'application/x-font-woff': ['.woff']});
  var app = express();
  var fetchIndex = express.static(path.join(destRootBase, "index.html"), { maxAge: 0, });
  app.use(function(req, res, next) {
    res.setHeader("Cache-Control", "no-cache");
    return next();
  });
  app.use(express.static(path.join(destRootBase)));

  app.use(require("webpack-dev-middleware")(compiler, {
    noInfo: true,
    publicPath: config.output.publicPath
  }));


  app.use("/", fetchIndex);
  app.use(/^\/api\/v[0-9]+/, proxyToPreprod);
  app.get(/^\/docs\/api$/, function (req, res) { res.redirect("/docs/api/v3");});

  app.use(/^\/landerImages/, express.static(path.join("polisStatic","landerImages")));
  app.use(/^\/images/, express.static(path.join("polisStatic","images")));
  app.use(/^\/[0-9][0-9A-Za-z]+/, fetchIndex); // conversation view
  app.use(/^\/explore\/[0-9][0-9A-Za-z]+/, fetchIndex); // power view
  app.use(/^\/share\/[0-9][0-9A-Za-z]+/, fetchIndex); // share view
  app.use(/^\/summary\/[0-9][0-9A-Za-z]+/, fetchIndex); // summary view
  app.use(/^\/m\/[0-9][0-9A-Za-z]+/, fetchIndex); // moderation view
  app.use(/^\/ot\/[0-9][0-9A-Za-z]+/, fetchIndex); // conversation view, one-time url

  app.use(/^\/iip\/[0-9][0-9A-Za-z]+/, fetchIndex);
  app.use(/^\/iim\/[0-9][0-9A-Za-z]+/, fetchIndex);

  app.use(/^\/course\/[0-9][0-9A-Za-z]+/, fetchIndex); // course view

  // TODO consider putting static files on /static, and then using a catch-all to serve the index.
  app.use(/^\/conversation\/create.*/, fetchIndex);
  app.use(/^\/user\/create$/, fetchIndex);
  app.use(/^\/user\/login$/, fetchIndex);
  app.use(/^\/welcome\/.*$/, fetchIndex);
  app.use(/^\/settings$/, fetchIndex);
  app.use(/^\/settings\/enterprise$/, fetchIndex);
  app.use(/^\/tut$/, fetchIndex);
  app.use(/^\/hk$/, fetchIndex);
  app.use(/^\/user\/logout$/, fetchIndex);
  app.use(/^\/inbox$/, fetchIndex);
  app.use(/^\/inboxApiTest$/, fetchIndex);
  app.use(/^\/pwresetinit$/, fetchIndex);
  app.use(/^\/demo\/[0-9][0-9A-Za-z]+/, fetchIndex);
  app.use(/^\/pwreset.*/, fetchIndex);
  app.use(/^\/prototype.*/, fetchIndex);
  app.use(/^\/plan.*/, fetchIndex);
  app.use(/^\/professors$/, express.static(path.join(destRootBase, "professors.html")));
  app.use(/^\/news$/, express.static(path.join(destRootBase, "news.html")));
  app.use(/^\/pricing$/, express.static(path.join(destRootBase, "pricing.html")));
  app.use(/^\/survey$/, express.static(path.join(destRootBase, "survey.html")));
  app.use(/^\/company$/, express.static(path.join(destRootBase, "company.html")));
  app.use(/^\/docs\/api$/, function (req, res) { res.redirect("/docs/api/v3");});
  app.use(/^\/api$/, function (req, res) { res.redirect("/docs/api");});
  app.use(/^\/docs\/api\/v3$/, express.static(path.join(destRootBase, "api_v3.html")));
  app.use(/^\/embed$/, express.static(path.join(destRootBase, "embed.html")));
  app.use(/^\/politics$/, express.static(path.join(destRootBase, "politics.html")));
  app.use(/^\/marketers$/, express.static(path.join(destRootBase, "marketers.html")));
  app.use(/^\/faq$/, express.static(path.join(destRootBase, "faq.html")));
  app.use(/^\/blog$/, express.static(path.join(destRootBase, "blog.html")));
  app.use(/^\/tos$/, express.static(path.join(destRootBase, "tos.html")));
  app.use(/^\/privacy$/, express.static(path.join(destRootBase, "privacy.html")));
  app.use(/^\/canvas_setup_backup_instructions$/, express.static(path.join(destRootBase, "canvas_setup_backup_instructions.html")));
  app.use(/^\/styleguide$/, express.static(path.join(destRootBase, "styleguide.html")));
  // Duplicate url for content at root. Needed so we have something for "About" to link to.
  app.use(/^\/billions$/, express.static(path.join(destRootBase, "billions.html")));
  app.use(/^\/wimp$/, express.static(path.join(destRootBase, "wimp.html")));
  app.use(/^\/try$/, express.static(path.join(destRootBase, "try.html")));

  app.listen(5001);
  console.log('localhost:5001');
});

function getGitHash() {
  return new Promise(function(resolve, reject) {
    exec("git log --pretty=\"%h\" -n 1", function(error, stdout, stderr) {
      if (error) {
        console.error('FAILED TO GET GIT HASH: ' + error);
        reject(stderr);
      } else {
        resolve(stdout);
      }
    })
  });
}

gulp.task('cleanDist', function(){
  rimraf.sync(baseDistRoot);
})


gulp.task('css', function(){
  gulp.src([
    devMode ? "css/polis_main_devel.scss" : "css/polis_main_dist.scss",
    ])
      .pipe(sass({
        loadPath: [__dirname + "/css"],
        // sourcemap: true,
        // sourcemapPath: '../scss'
      }))
      .pipe(concat("polis.css"))
      .pipe(gulp.dest(destRoot() + '/css'));
});

gulp.task('fontawesome', function() {
  gulp.src('bower_components/font-awesome/fonts/**/*')
    .pipe(gulp.dest(destRoot() + "/fonts"));
});
// TODO remove
gulp.task('sparklines', function() {
  var s = gulp.src('sparklines.svg')
    .pipe(gulp.dest(destRoot()));
});

gulp.task('embedJs', function() {
  return gulp.src([
    'api/embed.js',
    'api/embedPreprod.js',
    'api/embed_helper.js',
    'api/twitterAuthReturn.html',
    ])
  // .pipe(template({
  //   polisHostName: (preprodMode ? "preprod.pol.is" : "pol.is"),
  // }))
  .pipe(gulp.dest(destRootBase));
});

gulp.task('index', [
  'sparklines',
], function() {
  var s = gulp.src('index.html');
  var basepath = prepPathForTemplate(destRootRest);
  var domainWhitelist = '["' + polisConfig.domainWhitelist.join('","') + '"]';
  if (devMode) {
    s = s.pipe(template({
      basepath: basepath,
      basepath_visbundle: basepath_visbundle_dev,
      d3Filename: 'd3.js',
      useIntercom: !isTrue(polisConfig.DISABLE_INTERCOM),
      versionString: versionString,
      domainWhitelist: domainWhitelist,
    }));
  } else {
    s = s.pipe(template({
      //basepath: 'https://s3.amazonaws.com/pol.is',
      basepath: basepath, // proxy through server (cached by cloudflare, and easier than choosing a bucket for preprod, etc)
      basepath_visbundle: basepath,
      d3Filename: 'd3.min.js',
      useIntercom: !isTrue(polisConfig.DISABLE_INTERCOM),
      versionString: versionString,
      domainWhitelist: domainWhitelist,
    }));
  }
  return s.pipe(gulp.dest(destRootBase)).pipe(gulp.dest(destRoot())); // pipe to root to clobber current build, and also to cache-busted path to support loading old builds
});

gulp.task('templates', function(){

  //does not include participation, which is the main view, because the footer is not right /userCreate.handlebars$/,
  var topLevelViews = [/conversationGatekeeper.handlebars$/, /userCreate.handlebars$/, /create-user-form.handlebars$/, /login-form.handlebars$/, /settings.handlebars$/, /settingsEnterprise.handlebars$/, /summary.handlebars$/, /inbox.handlebars$/, /moderation.handlebars$/, /passwordResetForm.handlebars$/,  /explore.handlebars$/, /conversationGatekeeper.handlebars$/, /passwordResetInitForm.handlebars$/, /create-conversation-form.handlebars$/, /plan-upgrade.handlebars$/];
  var bannerNeedingViews = [/summary.handlebars$/, /inbox.handlebars$/, /moderation.handlebars$/, /explore.handlebars$/, /create-conversation-form.handlebars$/];

  function needsBanner(file) {
    return _.some(bannerNeedingViews, function(regex){
      return file.path.match(regex)
    });
  }
  function needsHeaderAndFooter(file) {
    return _.some(topLevelViews, function(regex){
      return file.path.match(regex)
    });
  }

  return gulp.src(['js/templates/*.hbs', 'js/templates/*.handlebars'])
    .pipe(tap(function(file) {

      if(needsHeaderAndFooter(file) || needsBanner(file)) {
        console.log(file.path)
        file._contents = Buffer.concat([
            // new Buffer(
            //   needsHeaderAndFooter(file) ? '<div class="wrap">' : ''
            // ),
            new Buffer(
              (needsHeaderAndFooter(file) ? '{{#ifNotEmbedded}}{{> header}}{{/ifNotEmbedded}}' : '') +
              (needsBanner(file) ? '{{#ifTrial}}{{> banner}}{{/ifTrial}}' : '')
            ),
            file._contents,
            // new Buffer(
              // needsHeaderAndFooter(file) ? '</div>' : ''
            // ),
            // new Buffer(
              // needsHeaderAndFooter(file) ? '{{> footer}}' : ''
            // ),
        ]);
      }
    }))
    .pipe(handlebars({
      outputType: 'node',
      wrapped: true,
    }))
    .pipe(gulp.dest('js/tmpl'));
});

gulp.task('jshint', function(){

  // WARNING: useJsHint gets mutated in watch builds

  gulp.src([
    'js/**/*.js',
    '!js/tmpl/**',
    '!js/3rdparty/**',
    ]).pipe(gulpif(useJsHint, jshint(

      {
         // reporter: 'jslint',
          curly: true, // require if,else blocks to have {}
          eqeqeq: true,
          trailing: true, // no trailing whitespace allowed
          forin: true, // requires all for in loops to filter object's items
          freeze: true, // prohibits overwriting prototypes of native objects such as Array, Date and so on.
          // immed: true,
          // latedef: true,
          // newcap: true,
          // noarg: true,
          // sub: true,
          // undef: true,
           unused: "vars",
          // quotmark: "double",
         // plusplus: true, // no ++ or --
        //  nonew: true,
          noarg: true, // no arguments.caller and arguments.callee (allow for optimizations)
          newcap: true, // constructors must be capitalized
        //  latedef: "nofunc",
          indent: 2,
          immed: true,
//          forin: true, require hasOwnProperty checks
          boss: true,
//          debug: true, // uncomment temporarily when you want to allow debugger; statements.
          // browser: true,
          // es3: true,
          globals: {
            d3: true,
            jQuery: true,
            console: true,
            require: true,
            define: true,
            requirejs: true,
            describe: true,
            expect: true,
            module: true,
            // it: true
          },
          // relax: eventually we should get rid of these
            //expr: true,
           // loopfunc: true,
            //shadow: true,
        }
        )))
      .pipe(jshint.reporter('default'))
})

gulp.task('lint', ['jshint']);


gulp.task('scriptsVis2', ['jshint'], function() {


  var webpackFilename = minified ? './webpack.config.js' : './webpack.config.unminified.js';

  var configProd = require(webpackFilename);
  config.output.publicPath = destRoot() + "/js/";

  return gulp.src('./vis2/vis2.js')
    .pipe(webpackStream(configProd))
    .pipe(gzip())
    .pipe(renameToRemoveGzExtention())
    .pipe(gulp.dest(destRoot() + "/js"));
});


gulp.task('scripts', ['templates', 'jshint'], function() {
  // Single entry point to browserify
  var s = gulp.src('js/main.js')
      .pipe(browserify({
        insertGlobals : true,
        debug : false, //!gulp.env.production
        // transform: ['hbsfy'],
        shim : {
          jquery: {
            path : devMode ? 'js/3rdparty/jquery.js' : 'js/3rdparty/jquery.min.js',
            exports: '$',
          },
          //TODO 'handlebars': 'templates/helpers/handlebarsWithHelpers', //this one has polis custom template helpers
          handlebars: {
            path : 'bower_components/handlebars/handlebars.runtime.js', //original handlebars
            exports: 'Handlebars',
          },
          originalbackbone: {
            path: 'bower_components/backbone/backbone', // backbone before modifications
            depends: { jquery: '$', underscore: '_' },
            exports: 'Backbone',
          },
          backbone: {
            path: 'js/net/backbonePolis', // polis-specific backbone modifications
            depends: { originalbackbone: "Backbone" },
            exports: "Backbone",
          },
          underscore: {
            path: 'bower_components/underscore/underscore',
            exports: '_',
          },
          handlebones: {
            path: 'bower_components/handlebones/handlebones',
            depends: { handlebars: 'Handlebars', backbone: 'Backbone' },
            exports: 'Handlebones',
          },
          bootstrap_alert: {  //all bootstrap files need to be added to the dependency array of js/main.js
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/alert',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_tab: {
            path : 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/tab',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_popover: {
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/popover',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_collapse: {
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/collapse',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_dropdown: {
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/dropdown',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_affix: {
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/affix',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          d3tooltips: {
            path: 'bower_components/d3-tip/index',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_tooltip: {
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/tooltip',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_button: {
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/button',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_transition: {
            path: 'bower_components/bootstrap-sass-official/assets/javascripts/bootstrap/transition',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          deepcopy: {
            path: 'bower_components/deepcopy/deepcopy.min.js',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          markdown: {
            path: 'bower_components/markdown/lib/markdown.js',
            depends: { jquery: "jQuery" },
            exports: "markdown",
          },
          VisView: {
            path: 'js/lib/VisView',
            depends: { d3tooltips: 'foo' }, // added to d3 object as d3.tip
            exports: 'VisView',
          },
        },
      }))
      .pipe(concat('polis.js'))
  // TODO      .pipe(header("copyright Polis... (except that libs are mixed in)

      if (prodMode || (preprodMode && minified)) {
        s = s.pipe(uglify());
      }
      if (!devMode) {
        s = s.pipe(gzip());
      }
      s = s.pipe(rename('polis.js'));
      return s.pipe(gulp.dest(destRoot() + "/js"));
});

function renameToRemoveGzExtention() {
  return rename(function (path) {
    // path.dirname += "/ciao";
    // path.basename += "-goodbye";
    // path.extname = ".md"

    // remove .gz extension
    var ext = path.extname;
    path.extname = ext.substr(0, ext.length- ".gz".length);
  });
}



// for big infrequently changing scripts that we don't want to concatenate
// on each dev build.
gulp.task("scriptsOther", function() {

  var files = [];
  if (devMode) {
    files.push('bower_components/d3/d3.js');
  } else {
    files.push('bower_components/d3/d3.min.js');
  }
  files.push('d3.v4.min.js');
  var s = gulp.src(files);
  if (!devMode) {
    s = s
      .pipe(uglify())
      .pipe(gzip())
      .pipe(renameToRemoveGzExtention());
  }
  return s.pipe(gulp.dest(destRoot() + "/js"));
});

gulp.task("scriptsTemp", function() {

  var files = [];
  files.push('d3.v4.min.js');
  var s = gulp.src(files);
  if (!devMode) {
    s = s
      .pipe(uglify())
      .pipe(gzip())
      .pipe(renameToRemoveGzExtention());
  }
  return s.pipe(gulp.dest(destRoot() + "/js"));
});

gulp.task("preprodConfig", function() {
  preprodMode = true;
  minified = true;
  scpSubdir = polisConfig.SCP_SUBDIR_PREPROD;
  s3Subdir = polisConfig.S3_BUCKET_PREPROD;
});

gulp.task("prodConfig", function() {
  prodMode = true;
  minified = true;
  scpSubdir = polisConfig.SCP_SUBDIR_PROD;
  s3Subdir = polisConfig.S3_BUCKET_PROD;
});

gulp.task("unminifiedConfig", function() {
  minified = false;
});


gulp.task("configureForProduction", function(callback) {
  devMode = false;
  destRootBase = "dist";

  console.log('getGitHash begin');
  // NOTE using callback instead of returning a promise since the promise isn't doing the trick - haven't tried updating gulp yet.
  getGitHash().then(function(hash) {
    hash = hash.toString().match(/[A-Za-z0-9]+/)[0];

    var d = new Date();
    var unique_token = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), hash].join("_");
    destRootRest = [staticFilesPrefix, unique_token].join("/");
    versionString = unique_token;

    console.log('done setting destRoot: ' + destRoot() + "  destRootRest: " + destRootRest + "  destRootBase: " + destRootBase);
    callback(null);
  }).catch(function(err) {
    console.error('getGitHash err');
    console.error(err);
    callback(true);
  });
});

gulp.task('common', [
  "scriptsOther",
  "scriptsTemp",
  "scripts",
  "css",
  "fontawesome",
  "index",
  "embedJs",
  ], function() {
    showDesktopNotification("BUILD UPDATED", "woohoo");
});

gulp.task('dev', [
  "common",
  ], function(){
});

gulp.task('dist', [
  "configureForProduction",
  ], function(callback){
    runSequence(
      'cleanDist',
      'scriptsVis2',
      'common',
      // ['build-scripts', 'build-styles'], // these two would be parallel
      // 'build-html',
      callback);
});

gulp.task("watchForDev", [
  "connect",
  ], function() {

    // don't block watch builds on lint
    // TODO: there's probably a way to run lint after each time the build finishes.
    useJsHint = false;

    gulp.watch([
      "js/**",
      "api/**",
      "!js/tmpl/**", // These are genterated, so don't watch!
      "css/**",
      "*.html",
      "polisStatic/**",
    ], function(e) {
      console.log("watch saw: " + e.path + " " + e.type);
      gulp.run("dev");
    });
});

function notifySlackOfDeployment(env) {
  var slackPath = '.polis_slack_creds.json';
  if (fs.existsSync(slackPath)) {
    var creds = JSON.parse(fs.readFileSync(slackPath));

    getGitHash().then(function(hash) {
      var slackToken = creds.apikey;
      var message = "deploying to " + env +
        "\n" + hash +
        "\n" + new Date();
      var url = "https://slack.com/api/chat.postMessage?token="+slackToken+"&channel=C02G773HT&text="+message+"&pretty=1";
      request(url);
    });
  }
}

gulp.task('prodBuildNoDeploy', [
  "prodConfig",
  "dist"
]);

gulp.task('deploy_TO_PRODUCTION', [
  "prodConfig",
  "dist"
], function() {

  notifySlackOfDeployment("prod");

  var uploader;
  if ('s3' === polisConfig.UPLOADER) {
    uploader = s3uploader({
      bucket: s3Subdir,
    });
  }
  if ('scp' === polisConfig.UPLOADER) {
    uploader = scpUploader({ // TODO needs to upload as prod somehow.
      // subdir: "cached",
      watch: function(client) {
        client.on('write', function(o) {
          console.log('write %s', o.destination);
        });
      },
    });
  }
  return deploy(uploader);
});


function doUpload() {
  notifySlackOfDeployment("preprod");

  var uploader;
  if ('s3' === polisConfig.UPLOADER) {
    uploader = s3uploader({
      bucket: s3Subdir,
    });
  }
  if ('scp' === polisConfig.UPLOADER) {
    uploader = scpUploader({ // TODO needs to upload as PREprod somehow.
      // subdir: "cached",
      watch: function(client) {
        client.on('write', function(o) {
          console.log('write %s', o.destination);
        });
      },
    });
  }
  return deploy(uploader);
}

gulp.task('deployPreprod', [
  "preprodConfig",
  "dist"
], doUpload);

gulp.task('deployPreprodUnminified', [
  "preprodConfig",
  "unminifiedConfig",
  "dist"
], doUpload);

gulp.task('deploySurvey', [
  "prodConfig",
  "dist"
], function() {

  var uploader = s3uploader({
    bucket: "survey.pol.is",
  });
  return deploy(uploader);
});

function s3uploader(params) {
    var creds = JSON.parse(fs.readFileSync('.polis_s3_creds_client.json'));
    creds = _.extend(creds, params);
    let f = function(o) {
      let oo = _.extend({
        delay: 1000,
        makeUploadPath: function(file) {
          let r = staticFilesPrefix + ".*";
          let match = file.path.match(RegExp(r));
          console.log(file);
          console.log(file.path);
          console.log(r, match);

          let fixed = (_.isString(o.subdir) && match && match[0]) ? match[0] : path.basename(file.path);
          console.log("upload path " + fixed);
          return fixed;
        },
      }, o);
      if (oo.headers) {
        delete oo.headers['Content-Type']; // s3 figures this out
      }

      return s3(creds, oo);
    };
    f.needsHeadersJson = false;
    return f;
}

function scpUploader(params) {
  var creds = JSON.parse(fs.readFileSync('.polis_scp_creds_client.json'));
  creds.dest = path.join(creds.dest, scpSubdir);
  scpConfig = _.extend({}, creds, params);
  let f = function(batchConfig) { // uploader
    console.log("scpUploader run", batchConfig);
    var o = _.extend({}, scpConfig);
    if (batchConfig.subdir) {
      console.log("batchConfig.subdir", batchConfig.subdir);
      console.log('old path', o.dest);
      o.dest = path.join(scpConfig.dest, batchConfig.subdir);
      console.log('new path', o.dest);
    } else {
      console.log('basic path', o.dest);
    }
    // console.log('------------------------ foofoo', batchConfig);
    // return foreach(function(stream, file){
    //   console.log('------------------------ stringSrc', file);
    //   return mergeStream(stream, stringSrc(file.name + ".headersJson", JSON.stringify(batchConfig.headers)));
    // }).pipe(scp(scpConfig));
    return scp(o);
  };
  f.needsHeadersJson = true;
  return f;
}

function deploy(uploader) {

    var cacheSecondsForContentWithCacheBuster = 31536000;

    function makeUploadPathHtml(file) {
      var fixed = file.path.match(RegExp("[^/]*$"))[0];
      console.log("upload path: " + fixed);
      return fixed;
    }

    function makeUploadPathFactory(tagForLogging) {
      return function(file) {
        console.log(file);
        console.log(file.path);
        let r = staticFilesPrefix + ".*";
        let match = file.path.match(RegExp(r));

        let fixed = match&&match[0] ? match[0] : file.path;
        console.log("upload path " + tagForLogging + ": " + fixed);
        return fixed;
      }
    }

    function deployBatch({srcKeep, srcIgnore, headers, logStatement, subdir}) {
      return new Promise(function(resolve, reject) {
        let gulpSrc = [srcKeep];
        if (srcIgnore) {
          gulpSrc.push(srcIgnore);
        }
        function doDeployBatch() {
          console.log("doDeployBatch", gulpSrc);

          gulp.src(gulpSrc, {read: true})
            .pipe(uploader({
              subdir: subdir,
              delay: 1000,
              headers: headers,
            })).on('error', function(err) {
              console.log('error1', err);
              reject(err);
            }).on('end', resolve);
        }
        // create .headersJson files
        if (uploader.needsHeadersJson) {
          let globOpts = {
            nodir: true,
          };
          if (srcIgnore) {
            globOpts.ignore = srcIgnore;
          }
          let files = glob.sync(srcKeep, globOpts)
          for (let i = 0; i < files.length; i++) {
            let file = files[i];
            let headerFilename = file + ".headersJson";
            fs.writeFileSync(headerFilename, JSON.stringify(headers));
            gulpSrc.push(headerFilename);
          }
        }
        doDeployBatch();
      });
    }


    const promises = [];
    // Cached Files without Gzip
    console.log(destRoot())

    const cachedSubdir = "cached";

    promises.push(deployBatch({
      srcKeep: destRoot() + '**/**',
      srcIgnore: '!' + destRoot() + '/js/**',
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-transform,public,max-age=MAX_AGE,s-maxage=MAX_AGE'.replace(/MAX_AGE/g, cacheSecondsForContentWithCacheBuster),
      },
      logStatement: "cached_no_gzip_"+cacheSecondsForContentWithCacheBuster,
      subdir: cachedSubdir,
    }));

    // Cached Gzipped CSS Files
    promises.push(deployBatch({
      srcKeep: destRoot() + '**/css/**', // simply saying "/css/**" causes the 'css' prefix to be stripped, and the files end up in the root of the bucket.
      headers: {
        'x-amz-acl': 'public-read',
        // 'Content-Encoding': 'gzip',
        'Content-Type': 'text/css; charset=UTF-8',
        'Cache-Control': 'no-transform,public,max-age=MAX_AGE,s-maxage=MAX_AGE'.replace(/MAX_AGE/g, cacheSecondsForContentWithCacheBuster),
      },
      logStatement: makeUploadPathFactory("cached_gzipped_"+cacheSecondsForContentWithCacheBuster),
      subdir: cachedSubdir,
    }));

    // Cached Gzipped JS Files
    promises.push(deployBatch({
      srcKeep: destRoot() + '**/js/**', // simply saying "/js/**" causes the 'js' prefix to be stripped, and the files end up in the root of the bucket.
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Encoding': 'gzip',
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-transform,public,max-age=MAX_AGE,s-maxage=MAX_AGE'.replace(/MAX_AGE/g, cacheSecondsForContentWithCacheBuster),
      },
      logStatement: makeUploadPathFactory("cached_gzipped_"+cacheSecondsForContentWithCacheBuster),
      subdir: cachedSubdir,
    }));

    // embed.js
    var embedJsCacheSeconds = 60;
    promises.push(deployBatch({
      srcKeep: destRootBase + '/**/embed.js',
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Type': 'application/javascript',
  //    'Content-Encoding': 'gzip', //causing issues (with s3), not sure why
        'Cache-Control': 'no-cache'.replace(/MAX_AGE/g, embedJsCacheSeconds),
      },
      logStatement:  function(file) {
        console.log("upload path cached_embedJs_"+embedJsCacheSeconds+" /embed.js");
        return "/embed.js";
      },
      subdir: null,
    }));

    // embedPreprod.js
    var embedJsCacheSeconds = 60;
    promises.push(deployBatch({
      srcKeep: destRootBase + '/**/embedPreprod.js',
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Type': 'application/javascript',
  //      'Content-Encoding': 'gzip', //causing issues (with s3), not sure why
        'Cache-Control': 'no-cache'.replace(/MAX_AGE/g, embedJsCacheSeconds),
      },
      logStatement: function(file) {
        console.log("upload path cached_embedJs_"+embedJsCacheSeconds+" /embedPreprod.js");
        return "/embedPreprod.js";
      },
      subdir: null,
    }));

    // TODO remove this duplication!
    var embedJsCacheSeconds = 60;
    promises.push(deployBatch({
      srcKeep: destRootBase + '/**/embed_helper.js',
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Type': 'application/javascript',
  //      'Content-Encoding': 'gzip', //causing issues (with s3), not sure why
        'Cache-Control': 'no-cache'.replace(/MAX_AGE/g, embedJsCacheSeconds),
      },
      logStatement: function(file) {
        console.log("upload path cached_embedJs_"+embedJsCacheSeconds+" /embed_helper.js");
        return "/embed_helper.js";
      },
      subdir: null,
    }));

    // TODO remove this duplication!
    var embedJsCacheSeconds = 60;
    promises.push(deployBatch({
      srcKeep: destRootBase + '/**/embed_helper.js',
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Type': 'application/javascript',
  //      'Content-Encoding': 'gzip', //causing issues (with s3), not sure why
        'Cache-Control': 'no-cache'.replace(/MAX_AGE/g, embedJsCacheSeconds),
      },
      logStatement: function(file) {
        console.log("upload path cached_embedJs_"+embedJsCacheSeconds+" /embed_helper.js");
        return "/embed_helper.js";
      },
      subdir: null,
    }));


    // TODO remove this duplication!
    var twitterAuthReturnCacheSeconds = 60;
    promises.push(deployBatch({
      srcKeep: destRootBase + '/**/twitterAuthReturn.html',
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Encoding': 'gzip',
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache'.replace(/MAX_AGE/g, twitterAuthReturnCacheSeconds),
      },
      logStatement: function(file) {
        console.log("uploading twitterAuthReturn");
        return "/twitterAuthReturn.html";
      },
      subdir: null,
    }));

    // HTML files (uncached)
    // (Wait until last to upload the html, since it will clobber the old html on S3, and we don't want that to happen before the new JS/CSS is uploaded.)
    promises.push(deployBatch({
      srcKeep: destRootBase + '/**/*.html',
      headers: {
        'x-amz-acl': 'public-read',
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
        // 'Cache-Control': 'no-transform,public,max-age=0,s-maxage=300', // NOTE: s-maxage is small for now, we could bump this up later once confident in cloudflare's cache purge workflow
      },
      logStatement: makeUploadPathHtml,
      subdir: null,
    }));

    return Promise.all(promises);
}

function doPurgeCache() {
  console.log("Purging cache for "+host +"\n");
  // var formatter = mapStream(function (data, callback) {
  //   var o = JSON.parse(data);
  //   if (!o.result === "success") {
  //     console.error("---------- PURGE CACHE FAILED ------------- " + data)
  //   }
  //   callback(null, data + "\n");
  // });
  request.get(host + "/api/v3/cache/purge/f2938rh2389hr283hr9823rhg2gweiwriu78")
    // .pipe(formatter)
    .pipe(process.stdout);
}

gulp.task("configureForCachePurge", function() {
  host = "https://pol.is";
});

gulp.task("configureForCachePurgePreprod", function() {
  host = "https://preprod.pol.is";
});

gulp.task('purgeCache', ["configureForCachePurge"], doPurgeCache);
gulp.task('purgeCachePreprod', ["configureForCachePurgePreprod"], doPurgeCache);

gulp.task('default', [
  "dev",
  "watchForDev",
  ], function() {
});

var tasks = process.argv.slice(2);
gulp.start.apply(gulp, tasks);

