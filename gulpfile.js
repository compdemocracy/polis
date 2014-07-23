var _ = require('underscore');
var exec = require('child_process').exec;
var express = require('express');
var gulp = require('gulp');
var s3 = require('gulp-s3');
var browserify = require('gulp-browserify');
var concat = require('gulp-concat'); 
var uglify = require('gulp-uglify')
var rename = require('gulp-rename');
var connect = require('gulp-connect');
var tap = require('gulp-tap');
var clean = require('gulp-clean');
var jshint = require('gulp-jshint');
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
var markdown = require('gulp-markdown')
var path = require('path');
var Promise = require('es6-promise').Promise;
var proxy = require('proxy-middleware');
var header = require('gulp-header');
var hbsfy = require("hbsfy").configure({
  extensions: ["handlebars"]
});
var https = require("https");
var fs = require('fs');
var request = require('request');
var rimraf = require("rimraf");
var runSequence = require('run-sequence');
var sass = require('gulp-ruby-sass');
var Stream = require('stream');
var sys = require('sys');
var url = require('url');


var useJsHint = false;
const baseDistRoot = "dist";
var destRootBase = "devel";
var destRootRest = '';  // in dist, will be the cachebuster path prefix
function destRoot() {
  return destRootBase + "/" + destRootRest;
}
var devMode = true;


gulp.task('connect', [], function() {
  express.static.mime.define({'application/x-font-woff': ['.woff']});
  var app = express();
  var fetchIndex = express.static(path.join(destRootBase, "index.html"));
  app.use(express.static(path.join(destRootBase)));
  app.use("/", fetchIndex);
  app.use('/v3', function(req, response) {
    var x = request("https://preprod.pol.is" + req.originalUrl);
    req.pipe(x);
    x.pipe(response);
  });
  app.use(/^\/[0-9][0-9A-Za-z]+/, fetchIndex); // conversation view
  app.use(/^\/explore\/[0-9][0-9A-Za-z]+/, fetchIndex); // power view
  app.use(/^\/share\/[0-9][0-9A-Za-z]+/, fetchIndex); // share view
  app.use(/^\/summary\/[0-9][0-9A-Za-z]+/, fetchIndex); // summary view
  app.use(/^\/m\/[0-9][0-9A-Za-z]+/, fetchIndex); // moderation view
  app.use(/^\/ot\/[0-9][0-9A-Za-z]+/, fetchIndex); // conversation view, one-time url
  // TODO consider putting static files on /static, and then using a catch-all to serve the index.
  app.use(/^\/conversation\/create.*/, fetchIndex);
  app.use(/^\/user\/create$/, fetchIndex);
  app.use(/^\/user\/login$/, fetchIndex);
  app.use(/^\/welcome\/.*$/, fetchIndex);
  app.use(/^\/settings$/, fetchIndex);
  app.use(/^\/user\/logout$/, fetchIndex);
  app.use(/^\/inbox.*/, fetchIndex);
  app.use(/^\/pwresetinit$/, fetchIndex);
  app.use(/^\/demo\/[0-9][0-9A-Za-z]+/, fetchIndex);
  app.use(/^\/pwreset.*/, fetchIndex);
  app.use(/^\/prototype.*/, fetchIndex);
  app.use(/^\/plan.*/, fetchIndex);
  app.use(/^\/professors$/, express.static(path.join(destRootBase, "professors.html")));
  app.use(/^\/pricing$/, express.static(path.join(destRootBase, "pricing.html")));
  app.use(/^\/company$/, express.static(path.join(destRootBase, "company.html")));
  app.use(/^\/api$/, express.static(path.join(destRootBase, "api.html")));
  app.use(/^\/embed$/, express.static(path.join(destRootBase, "embed.html")));
  app.use(/^\/politics$/, express.static(path.join(destRootBase, "politics.html")));
  app.use(/^\/marketers$/, express.static(path.join(destRootBase, "marketers.html")));
  app.use(/^\/faq$/, express.static(path.join(destRootBase, "faq.html")));
  app.use(/^\/blog$/, express.static(path.join(destRootBase, "blog.html")));
  app.use(/^\/tos$/, express.static(path.join(destRootBase, "tos.html")));
  app.use(/^\/privacy$/, express.static(path.join(destRootBase, "privacy.html")));
  // Duplicate url for content at root. Needed so we have something for "About" to link to.
  app.use(/^\/about$/, express.static(path.join(destRootBase, "lander.html")));
  app.use(/^\/try$/, express.static(path.join(destRootBase, "try.html")));

  app.listen(8000);
  console.log('localhost:8000');
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
        sourcemap: true,
        sourcemapPath: '../scss'
      }))
      .pipe(concat("polis.css"))
      .pipe(gulp.dest(destRoot() + '/css'))
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
gulp.task('index', [
  'sparklines',
], function() {
  var s = gulp.src('index.html');
  if (devMode) {
    s = s.pipe(template({
      basepath: destRootRest,
      d3Filename: 'd3.js',
      r2d3Filename: 'r2d3.js',
    }))
  } else {
    s = s.pipe(template({
      //basepath: 'https://s3.amazonaws.com/pol.is',
      basepath: destRootRest, // proxy through server (cached by cloudflare, and easier than choosing a bucket for preprod, etc)
      d3Filename: 'd3.min.js',
      r2d3Filename: 'r2d3.min.js',
    }));
  }
  return s.pipe(gulp.dest(destRootBase));
});

gulp.task('templates', function(){

  //does not include participation, which is the main view, because the footer is not right /userCreate.handlebars$/,
  var topLevelViews = [/faq.handlebars$/, /settings.handlebars$/, /summary.handlebars$/, /inbox.handlebars$/, /moderation.handlebars$/, /passwordResetForm.handlebars$/,  /explore.handlebars$/, /conversationGatekeeper.handlebars$/, /passwordResetInitForm.handlebars$/, /create-conversation-form.handlebars$/, /plan-upgrade.handlebars$/];
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

  gulp.src(['js/templates/*.hbs', 'js/templates/*.handlebars'])
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
  gulp.src('js/**/*.js')
      .pipe(gulpif(useJsHint, jshint(

      {
         // reporter: 'jslint',
          curly: true, // require if,else blocks to have {}
          eqeqeq: true,
          trailing: true, // no trailing whitespace allowed
          // immed: true,
          // latedef: true,
          // newcap: true,
          // noarg: true,
          // sub: true,
          // undef: true,
        //  unused: true,
          quotmark: "double",
         // plusplus: true, // no ++ or --
        //  nonew: true,
          noarg: true, // no arguments.caller and arguments.callee (allow for optimizations)
          newcap: true, // constructors must be capitalized
        //  latedef: "nofunc",
         // indent: 2,
          immed: true,
//          forin: true, require hasOwnProperty checks
          boss: true,
//          debug: true, // uncomment temporarily when you want to allow debugger; statements.
          // browser: true,
          es3: true,          
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

gulp.task('scripts', ['templates', 'jshint'], function() {
  // Single entry point to browserify
  var s = gulp.src('js/main.js')
      .pipe(browserify({
        insertGlobals : true,
        debug : false, //!gulp.env.production
        // transform: ['hbsfy'],
        shim : {
          jquery: {
            path : devMode ? 'js/lib/jquery.js' : 'js/lib/jquery.min.js',
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
          owl: {
            path: 'bower_components/owlcarousel/owl-carousel/owl.carousel.min.js',
            depends: { jquery: "jQuery" },
            exports: null,
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
      if (!devMode) {
        s = s
          .pipe(uglify())
          .pipe(gzip())
      }
      s = s.pipe(rename('polis.js'));
      return s.pipe(gulp.dest(destRoot() + "/js"));
});

// for big infrequently changing scripts that we don't want to concatenate
// on each dev build.
gulp.task("scriptsOther", function() {

  var files = [];
  if (devMode) {
    files.push('bower_components/d3/d3.js');
    files.push('bower_components/r2d3/r2d3.js');
  } else {
    files.push('bower_components/d3/d3.min.js');
    files.push('bower_components/r2d3/r2d3.min.js');
  }
  var s = gulp.src(files);
  if (!devMode) {
    s = s
      .pipe(uglify())
      .pipe(gzip())
      .pipe(rename(function (path) {
        // path.dirname += "/ciao";
        // path.basename += "-goodbye";
        // path.extname = ".md"

        // remove .gz extension
        var ext = path.extname;
        path.extname = ext.substr(0, ext.length- ".gz".length);
      }));
  }
  return s.pipe(gulp.dest(destRoot() + "/js"));
});

// ---------------------- BEGIN ABOUT PAGE STUFF ------------------------

gulp.task('about', function () {

    var top = fs.readFileSync('js/templates/about/partials/top.handlebars', {encoding: "utf8"});
    var header = fs.readFileSync('js/templates/about/partials/header.handlebars', {encoding: "utf8"});
    var footer = fs.readFileSync('js/templates/about/partials/footer.handlebars', {encoding: "utf8"});

    var templateData = {
        foo: 'bar333'
    },
    options = {
        ignorePartials: false, //ignores the unknown footer2 partial in the handlebars template, defaults to false
        partials : {
               top : top,
            header : header,
            footer : footer
        },
        helpers : {
            // capitals : function(str){
            //     return str.toUpperCase();   
            // }
        }
    }

    return gulp.src('js/templates/about/*.handlebars')
        .pipe(compileHandlebars(templateData, options))
        .pipe(rename(function (path) {
          path.extname = ".html"
        }))
        .pipe(gulp.dest(destRoot()));
});




// function promiseToStream(p) {
//   var Readable = Stream.Readable;
//   var rs = new Readable;
//   p.then(function(val) {
//     rs.push(val);
//     rs.push(null);
//   }).catch(function(err) {
//     rs.emit("error", err);
//   });
//   return rs;
// }


// ----------------------- END ABOUT PAGE STUFF -------------------------


gulp.task("configureForProduction", ["cleanDist"], function(callback) {
  devMode = false;

  console.log('getGitHash begin');
  // NOTE using callback instead of returning a promise since the promise isn't doing the trick - haven't tried updating gulp yet.
  getGitHash().then(function(hash) {
    hash = hash.toString().match(/[A-Za-z0-9]+/)[0];
    destRootRest = "/cached/" + hash;
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
  "scripts",
  "css",
  "fontawesome",
  "index",
  ], function() {
});

gulp.task('dev', [
  "common",
  ], function(){
});

gulp.task('dist', [
  "configureForProduction",
  ], function(callback){
    runSequence('common',
              // ['build-scripts', 'build-styles'], // these two would be parallel
              // 'build-html',
              callback);
});

gulp.task("watchForDev", [
  "connect",
  ], function() {
    gulp.watch([
      "js/**",
      "!js/tmpl/**", // These are genterated, so don't watch!
      "css/**",
      "*.html",
    ], function(e) {
      console.log("watch saw: " + e.path + " " + e.type);
      gulp.run("dev");
    });
});



gulp.task('deploy', [
  // "dist"
  "configureForProduction",
], function() {
  return deploy({
      bucket: "pol.is"
  });
});

gulp.task('deployPreprod', [
  // "dist"
  "configureForProduction",
], function() {
  return deploy({
      bucket: "preprod.pol.is"
  });
});
 
function deploy(params) {
    var creds = JSON.parse(fs.readFileSync('.polis_s3_creds_client.json'));
    creds = _.extend(creds, params);

    // Files without Gzip
    gulp.src([
      destRoot + '/**',
      '!' + destRoot() + '/js/**',
      ], {read: false}).pipe(s3(creds, {
        delay: 1000,
        headers: {
          'x-amz-acl': 'public-read',
        }
      }));

    // Gzipped Files
    gulp.src([
      destRoot() + '/**/js/**', // simply saying "/js/**" causes the 'js' prefix to be stripped, and the files end up in the root of the bucket.
      ], {read: false}).pipe(s3(creds, {
        delay: 1000,
        headers: {
          'x-amz-acl': 'public-read',
          'Content-Encoding': 'gzip',
        }
      }));

}


// For now, you'll have to copy the assets from the other repo into the "about" directory
gulp.task('deployAboutPage', [
  "configureForProduction",
  "about",
  ], function() {
  return deployAboutPage({
      bucket: "pol.is"
  });
});

gulp.task('deployAboutPagePreprod', [
  "configureForProduction",
  "about",
  ], function() {
  return deployAboutPage({
      bucket: "preprod.pol.is"
  });
});

function deployAboutPage(params) {

    var creds = JSON.parse(fs.readFileSync('.polis_s3_creds_client.json'));

    creds = _.extend(creds, params);
    
    var root = "../about-polis";
    var dist = "../about-polis/dist";
    return gulp.src([
      dist + "/api.html",
      dist + "/company.html",
      dist + "/embed.html",
      dist + "/faq.html",
      dist + "/lander.html",
      dist + "/privacy.html",
      dist + "/professors.html",
      dist + "/tos.html",
      dist + "/unsupportedBrowser.html",

      dist + "/css/polis.css",

      root + "/src/about.css",
      root + "/**/rainbow/**/*",
      root + "/**/node_modules/underscore/underscore-min.js", // ** to preserve path 
      root + "/**/landerImages/*",
      root + "/**/bower_components/font-awesome/css/font-awesome.min.css",
      root + "/**/bower_components/font-awesome/fonts/**",
      root + "/**/bower_components/jquery/dist/jquery.js",
      root + "/**/bower_components/jquery/dist/jquery.min.js"
      ], {read: false}).pipe(s3(creds, {
        delay: 1000,
        headers: {
          'x-amz-acl': 'public-read',
        }
      }));
}


gulp.task('default', [
  "dev",
  "watchForDev",
  ], function() {
});


