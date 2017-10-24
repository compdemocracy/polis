// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require('lodash');
var exec = require('child_process').exec;
var gulp = require('gulp');
var isTrue = require('boolean');
var s3 = require('gulp-s3');
var rename = require('gulp-rename');
var gzip = require('gulp-gzip');
var path = require('path');
var Promise = require('es6-promise').Promise;
var fs = require('fs');
var rimraf = require("rimraf");
var runSequence = require('run-sequence');

const staticFilesPrefix = "cached";
const baseDistRoot = "dist";
var destRootBase = "devel";
var destRootRest = '/';  // in dist, will be the cachebuster path prefix
var versionString = 'VERSION_ERROR';
function destRoot() {
  var root = path.join(destRootBase, destRootRest);
  console.log(root);
  return root;
}
function destRootAbout() {
  return destRootBase;
}
var devMode = true;
var minified = false;
var preprodMode = false;
var prodMode = false;
var host;


function prepPathForTemplate(path) {
  // add slash at front if missing
  if (path.match(/^[^\/]/)) {
    path = "/" + path;
  }
  path = path.replace(/\/*$/,""); // remove trailing slash
  return path;
}


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


gulp.task('bundle', [
], function(callback) {
    var cmd = minified ? "npm run build:webpack" : "npm run build:webpack_unminified";
    exec(cmd, function(error, stdout, stderr) {
      callback(error);
    });
});

gulp.task('index', [
], function() {
  // var githash = getGitHash();
  var bundlePath =  [destRootRest, "admin_bundle.js"].join("/");
  var index = fs.readFileSync('index.html', {encoding: "utf8"});
  index = index.replace("/dist/admin_bundle.js",  '/' + [destRootRest, "js", "admin_bundle.js"].join('/'));
  index = index.replace("NULL_VERSION",  versionString);
  index = index.replace("<%= useIntercom %>", !isTrue(process.env.DISABLE_INTERCOM));
  index = index.replace("<%= usePlans %>", !isTrue(process.env.DISABLE_PLANS));


  // index goes to the root of the dist folder.
  var indexDest = [destRootBase, "index_admin.html"].join("/");
  // fs.mkdirSync(destRootBase);
  fs.writeFileSync(indexDest, index);
});

gulp.task('embed', [
], function() {
  var index = fs.readFileSync('embed.html', {encoding: "utf8"});
  var dest = [destRootBase, "embed.html"].join("/");
  // fs.mkdirSync(destRootBase);
  fs.writeFileSync(dest, index);
});

gulp.task('embedPreprod', [
], function() {
  var index = fs.readFileSync('embedPreprod.html', {encoding: "utf8"});
  var dest = [destRootBase, "embedPreprod.html"].join("/");
  // fs.mkdirSync(destRootBase);
  fs.writeFileSync(dest, index);
});


gulp.task('embedReport', [
], function() {
  var index = fs.readFileSync('embedReport.html', {encoding: "utf8"});
  var dest = [destRootBase, "embedReport.html"].join("/");
  // fs.mkdirSync(destRootBase);
  fs.writeFileSync(dest, index);
});

gulp.task('embedReportPreprod', [
], function() {
  var index = fs.readFileSync('embedReportPreprod.html', {encoding: "utf8"});
  var dest = [destRootBase, "embedReportPreprod.html"].join("/");
  // fs.mkdirSync(destRootBase);
  fs.writeFileSync(dest, index);
});


gulp.task('404', [
], function() {
  var index = fs.readFileSync('404.html', {encoding: "utf8"});
  var dest = [destRootBase, "404.html"].join("/");
  // fs.mkdirSync(destRootBase);
  fs.writeFileSync(dest, index);
});



gulp.task("preprodConfig", function() {
  preprodMode = true;
  minified = true;
});

gulp.task("unminifiedConfig", function() {
  minified = false;
});

gulp.task("prodConfig", function() {
  prodMode = true;
  minified = true;
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


gulp.task("scripts", function() {
  var files = ["dist/admin_bundle.js"];
  var s = gulp.src(files);
  s = s
    .pipe(gzip())
    .pipe(rename(function (path) {
      // remove .gz extension
      var ext = path.extname;
      console.log("foo", path);
      path.extname = ext.substr(0, ext.length- ".gz".length);
    }));
  return s.pipe(gulp.dest(destRoot() + "/js"));
});

gulp.task('common', [
  ], function(callback) {
    runSequence(
      'bundle',
      'index',
      'embed',
      'embedPreprod',
      'embedReport',
      'embedReportPreprod',
      '404',
      'scripts',
      callback);
});


gulp.task('dist', [
  "configureForProduction",
  ], function(callback){
    runSequence(
      'cleanDist',
      'common',
      // ['build-scripts', 'build-styles'], // these two would be parallel
      // 'build-html',
      callback);
});


gulp.task('deploy_TO_PRODUCTION', [
  "prodConfig",
  "dist"
], function() {

  return deploy({
      bucket: process.env.BUCKET_PROD
  });
});

gulp.task('deployPreprod', [
  "preprodConfig",
  "dist"
], function() {

  return deploy({
      bucket: process.env.BUCKET_PREPROD
  });
});

gulp.task('deployPreprodUnminified', [
  "preprodConfig",
  "unminifiedConfig",
  "dist"
], function() {

  return deploy({
      bucket: process.env.BUCKET_PREPROD
  });
});

gulp.task('fontsPreprod', [
  "preprodConfig",
], function() {
  return deployFonts({
      bucket: process.env.BUCKET_PREPROD
  });
});

gulp.task('fontsProd', [
  "prodConfig",
], function() {
  return deployFonts({
      bucket: process.env.BUCKET_PROD
  });
});

function deployFonts(params) {
    var creds = JSON.parse(fs.readFileSync('.polis_s3_creds_client.json'));
    creds = _.extend(creds, params);

    //var fontCacheSeconds = 31536000;
    var fontCacheSeconds = 99;

    function makeUploadPathFactory(tagForLogging) {
      return function(file) {
        var fixed = file.path.match(RegExp("font.*"))[0];
        console.log("upload path " + tagForLogging + ": " + fixed);
        return fixed;
      }
    }

    ['woff','woff2','otf','ttf','svg','eot'].forEach(function(ext) {
        var contentType = {
            'woff': 'application/x-font-woff',
            'woff2': 'application/font-woff2',
            'ttf': 'application/x-font-ttf',
            'otf': 'application/x-font-opentype',
            'svg': 'image/svg+xml',
            'eot': 'application/vnd.ms-fontobject',
        }[ext];

        gulp.src([
          './font/*.' + ext,
          ], {read: false})
        .pipe(s3(creds, {
            delay: 1000,
            headers: {
              'x-amz-acl': 'public-read',
              'Content-Type': contentType,
              'Cache-Control': 'no-transform,public,max-age=MAX_AGE,s-maxage=MAX_AGE'.replace(/MAX_AGE/g, fontCacheSeconds),
            },
            makeUploadPath: makeUploadPathFactory("cached_gzipped_"+fontCacheSeconds),
          }));
      });

}

function deploy(params) {
    var creds = JSON.parse(fs.readFileSync('.polis_s3_creds_client.json'));
    creds = _.extend(creds, params);

    var cacheSecondsForContentWithCacheBuster = 31536000;

    function makeUploadPathHtml(file) {
      var fixed = file.path.match(RegExp("[^/]*$"))[0];
      console.log("upload path: " + fixed);
      return fixed;
    }

    function makeUploadPathFactory(tagForLogging) {
      return function(file) {
        var fixed = file.path.match(RegExp(staticFilesPrefix + ".*"))[0];
        console.log("upload path " + tagForLogging + ": " + fixed);
        return fixed;
      }
    }

    // Cached Gzipped Files
    gulp.src([
      destRoot() + '**/js/**', // simply saying "/js/**" causes the 'js' prefix to be stripped, and the files end up in the root of the bucket.
      ], {read: false})
    .pipe(s3(creds, {
        delay: 1000,
        headers: {
          'x-amz-acl': 'public-read',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'no-transform,public,max-age=MAX_AGE,s-maxage=MAX_AGE'.replace(/MAX_AGE/g, cacheSecondsForContentWithCacheBuster),
        },
        makeUploadPath: makeUploadPathFactory("cached_gzipped_"+cacheSecondsForContentWithCacheBuster),
      }));

    // HTML files (uncached)
    // (Wait until last to upload the html, since it will clobber the old html on S3, and we don't want that to happen before the new JS/CSS is uploaded.)
    gulp.src([
      destRootBase + '/**/*.html',
      ], {read: false}).pipe(s3(creds, {
        delay: 1000,
        headers: {
          'x-amz-acl': 'public-read',
          'Cache-Control': 'no-cache',
          'Content-Type': 'text/html; charset=UTF-8',
          // 'Cache-Control': 'no-transform,public,max-age=0,s-maxage=300', // NOTE: s-maxage is small for now, we could bump this up later once confident in cloudflare's cache purge workflow
        },
        makeUploadPath: makeUploadPathHtml,
      }));
}

var tasks = process.argv.slice(2);
gulp.start.apply(gulp, tasks);

