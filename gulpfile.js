var gulp = require('gulp');
var jshint = require('gulp-jshint');
//var gulpif = require('gulp-if');
//var gutil = require('gulp-util');
//var path = require('path');
//var Promise = require('es6-promise').Promise;
//var proxy = require('proxy-middleware');
//var fs = require('fs');
//var mapStream = require('map-stream');
//var request = require('request');
//var rimraf = require("rimraf");
//var runSequence = require('run-sequence');
//var sys = require('sys');
//var url = require('url');

gulp.task('jshint', function(){
  gulp.src(['*.js','js/**/*.js'])
      .pipe(jshint(

      {
        unused:false,
        noempty: false,
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
//          quotmark: "double",
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
        ))
      .pipe(jshint.reporter('default'));
});



gulp.task('default', [
  "jshint",
  ], function() {
});


