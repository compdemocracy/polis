var gulp = require('gulp');
var browserify = require('gulp-browserify');
var concat = require('gulp-concat'); 
var uglify = require('gulp-uglify')
var rename = require('gulp-rename');
var connect = require('gulp-connect'); 
var less = require('gulp-less');
var clean = require('gulp-clean');
var jshint = require('gulp-jshint');
var gzip = require('gulp-gzip');
var template = require('gulp-template');
var path = require('path');
var combineCSS = require('combine-css');
var gulpif = require('gulp-if');
var gutil = require('gulp-util');
var handlebars = require('gulp-handlebars');
// var styl = require('gulp-styl');  
// var refresh = require('gulp-livereload');  
// var lr = require('tiny-lr');  
// var server = lr();
var header = require('gulp-header');
var hbsfy = require("hbsfy").configure({
  extensions: ["handlebars"]
});


var useJsHint = false;
var destRoot = __dirname + "/devel";
var devMode = true;

gulp.task('connect', connect.server({
  root: destRoot,
  port: 8000,
  livereload: true,
  // open: {
  //   browser: 'chrome' // if not working OS X browser: 'Google Chrome'
  // }
}));

gulp.task('cleancss', function(){
  gulp.src(destRoot + '/css', {read: false})
      .pipe(clean())
})


gulp.task('less', function(){
  gulp.src([
    "css/polis_main.less",
    ])
      .pipe(less())
      .pipe(concat("polis.css"))
      .pipe(gulp.dest(destRoot + '/css'))
});

gulp.task('fontawesome', function() {
  gulp.src('bower_components/font-awesome/font/**/*')
    .pipe(gulp.dest(destRoot + "/font"));
});
gulp.task('index', function() {
  var s = gulp.src('index.html');
  if (devMode) {
    s = s.pipe(template({
      basepath: '',
      d3Filename: 'd3.js',
    }))
  } else {
    s = s.pipe(template({
      basepath: 'https://s3.amazonaws.com/www.polis.io',
      d3Filename: 'd3.min.js',
    }));
  }
  return s.pipe(gulp.dest(destRoot));
});

gulp.task('templates', function(){
  gulp.src(['js/templates/*.hbs', 'js/templates/*.handlebars'])
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
          thorax: {
            path: 'bower_components/thorax/thorax',
            depends: { handlebars: 'Handlebars', backbone: 'Backbone' },             
            exports: 'Thorax',
          },
          bootstrap_alert: {  //all bootstrap files need to be added to the dependency array of js/main.js
            path: 'bower_components/bootstrap/js/alert',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_tab: {
            path : 'bower_components/bootstrap/js/tab',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_popover: {
            path: 'bower_components/bootstrap/js/popover',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_collapse: {
            path: 'bower_components/bootstrap/js/collapse',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_dropdown: {
            path: 'bower_components/bootstrap/js/dropdown',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_affix: {
            path: 'bower_components/bootstrap/js/affix',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          d3tooltips: {
            path: 'bower_components/d3-tip/index',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_tooltip: {
            path: 'bower_components/bootstrap/js/tooltip',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_button: { 
            path: 'bower_components/bootstrap/js/button',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_transition: {
            path: 'bower_components/bootstrap/js/transition',
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
      return s.pipe(gulp.dest(destRoot + "/js"));
});

// for big infrequently changing scripts that we don't want to concatenate
// on each dev build.
gulp.task("scriptsOther", function() {

  var files = [];
  if (devMode) {
    files.push('bower_components/d3/d3.js');
  } else {
    files.push('bower_components/d3/d3.min.js');
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
  return s.pipe(gulp.dest(destRoot + "/js"));
});


gulp.task("configureForProduction", function() {
  destRoot = "./dist";
  devMode = false;
});

gulp.task('common', [
  "scriptsOther",
  "scripts",
  "less",
  "fontawesome",
  "index",
  ], function(){
});

gulp.task('default', [
  "common",
  "connect",
  ], function(){
});

gulp.task('dist', [
  "configureForProduction",
  "common",
  "connect",
  ], function(){
});
