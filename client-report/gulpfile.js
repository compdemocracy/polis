// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("lodash");
var exec = require("child_process").exec;
var glob = require("glob");
var gulp = require("gulp");
var s3 = require("gulp-s3");
var rename = require("gulp-rename");
var gzip = require("gulp-gzip");
var path = require("path");
var Promise = require("es6-promise").Promise;
var fs = require("fs");
var rimraf = require("rimraf");
var runSequence = require("run-sequence");

const reportUploader = process.env.REPORT_UPLOADER || 'local';
const s3BucketProd = process.env.S3_BUCKET_PROD;
const s3BucketPreprod = process.env.S3_BUCKET_PREPROD;
const localOutputPath = './build';

const staticFilesPrefix = "cached";
const baseDistRoot = "dist";
var destRootBase = "devel";
var destRootRest = "/"; // in dist, will be the cachebuster path prefix
var versionString = "VERSION_ERROR";
function destRoot() {
  var root = path.join(destRootBase, destRootRest);
  console.log(root);
  return root;
}

let s3Subdir;

// function prepPathForTemplate(path) {
//   // add slash at front if missing
//   if (path.match(/^[^\/]/)) {
//     path = "/" + path;
//   }
//   path = path.replace(/\/*$/, ""); // remove trailing slash
//   return path;
// }

function getGitHash() {
  return new Promise(function (resolve/*, reject*/) {
    if (process.env.GIT_HASH) {
      resolve(process.env.GIT_HASH);
    } else {
      console.log("Not GIT_HASH provided. Skipping use.");
      resolve();
    }
  });
}

gulp.task("cleanDist", function () {
  rimraf.sync(baseDistRoot);
});

gulp.task("bundle", [], function (callback) {
  exec("npm run build", function (error/*, stdout, stderr*/) {
    callback(error);
  });
});

gulp.task("index", [], function () {
  var index = fs.readFileSync("index.html", { encoding: "utf8" });
  index = index.replace(
    "/dist/report_bundle.js",
    "/" + [destRootRest, "js", "report_bundle.js"].join("/")
  );
  index = index.replace("NULL_VERSION", versionString);

  // index goes to the root of the dist folder.
  var indexDest = [destRootBase, "index_report.html"].join("/");
  // fs.mkdirSync(destRootBase);
  fs.writeFileSync(indexDest, index);
});

gulp.task("preprodConfig", function () {
  s3Subdir = s3BucketPreprod;
});

gulp.task("prodConfig", function () {
  s3Subdir = s3BucketProd;
});

gulp.task("configureForProduction", function (callback) {
  destRootBase = "dist";

  console.log("getGitHash begin");
  // NOTE using callback instead of returning a promise since the promise isn't doing the trick - haven't tried updating gulp yet.
  getGitHash()
    .then(function (hash) {
      var d = new Date();
      var tokenParts = [
        d.getFullYear(),
        d.getMonth() + 1,
        d.getDate(),
        d.getHours(),
        d.getMinutes(),
        d.getSeconds(),
      ];

      if (hash) {
        hash = hash.toString().match(/[A-Za-z0-9]+/)[0];
        tokenParts.push(hash);
      }

      var unique_token = tokenParts.join("_");
      destRootRest = [staticFilesPrefix, unique_token].join("/");
      versionString = unique_token;

      console.log(
        "done setting destRoot: " +
          destRoot() +
          "  destRootRest: " +
          destRootRest +
          "  destRootBase: " +
          destRootBase
      );
      callback(null);
    })
    .catch(function (err) {
      console.error("getGitHash err");
      console.error(err);
      callback(true);
    });
});

gulp.task("scripts", function () {
  var files = ["dist/report_bundle.js"];
  var s = gulp.src(files);
  s = s.pipe(gzip()).pipe(
    rename(function (path) {
      // remove .gz extension
      var ext = path.extname;
      console.log("foo", path);
      path.extname = ext.substr(0, ext.length - ".gz".length);
    })
  );
  return s.pipe(gulp.dest(destRoot() + "/js"));
});

gulp.task("common", [], function (callback) {
  runSequence("bundle", "index", "scripts", callback);
});

gulp.task("dist", ["configureForProduction"], function (callback) {
  runSequence(
    "cleanDist",
    "common",
    // ['build-scripts', 'build-styles'], // these two would be parallel
    // 'build-html',
    callback
  );
});

function localUploader(params) {
  params.subdir = params.subdir || ''
  return gulp.dest(path.join(localOutputPath, params.subdir))
}

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

function deploy(uploader) {
  var cacheSecondsForContentWithCacheBuster = 31536000;

  function makeUploadPathHtml(file) {
    var fixed = file.path.match(RegExp("[^/]*$"))[0];
    console.log("upload path: " + fixed);
    return fixed;
  }

  function makeUploadPathFactory(tagForLogging) {
    return function (file) {
      console.log(file);
      console.log(file.path);
      let r = staticFilesPrefix + ".*";
      let match = file.path.match(RegExp(r));

      let fixed = match && match[0] ? match[0] : file.path;
      console.log("upload path " + tagForLogging + ": " + fixed);
      return fixed;
    };
  }

  function deployBatch({ srcKeep, srcIgnore, headers, subdir/*, logStatement*/ }) {
    return new Promise(function (resolve, reject) {
      let gulpSrc = [srcKeep];
      if (srcIgnore) {
        gulpSrc.push(srcIgnore);
      }
      function doDeployBatch() {
        console.log("doDeployBatch", gulpSrc);

        gulp
          .src(gulpSrc, { read: true })
          .pipe(
            uploader({
              subdir: subdir,
              delay: 1000,
              headers: headers,
            })
          )
          .on("error", function (err) {
            console.log("error1", err);
            reject(err);
          })
          .on("end", resolve);
      }
      // create .headersJson files
      if (uploader.needsHeadersJson) {
        let globOpts = {
          nodir: true,
        };
        if (srcIgnore) {
          globOpts.ignore = srcIgnore;
        }
        let files = glob.sync(srcKeep, globOpts);
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
  console.log(destRoot());

  const cachedSubdir = "cached";

  // Cached Gzipped JS Files
  promises.push(
    deployBatch({
      srcKeep: destRoot() + "**/js/**", // simply saying "/js/**" causes the 'js' prefix to be stripped, and the files end up in the root of the bucket.
      headers: {
        "x-amz-acl": "public-read",
        "Content-Encoding": "gzip",
        "Content-Type": "application/javascript",
        "Cache-Control": "no-transform,public,max-age=MAX_AGE,s-maxage=MAX_AGE".replace(
          /MAX_AGE/g,
          cacheSecondsForContentWithCacheBuster
        ),
      },
      logStatement: makeUploadPathFactory(
        "cached_gzipped_" + cacheSecondsForContentWithCacheBuster
      ),
      subdir: cachedSubdir,
    })
  );

  // HTML files (uncached)
  // (Wait until last to upload the html, since it will clobber the old html on S3, and we don't want that to happen before the new JS/CSS is uploaded.)
  promises.push(
    deployBatch({
      srcKeep: destRootBase + "/**/*.html",
      headers: {
        "x-amz-acl": "public-read",
        "Content-Type": "text/html; charset=UTF-8",
        "Cache-Control": "no-cache",
        // 'Cache-Control': 'no-transform,public,max-age=0,s-maxage=300', // NOTE: s-maxage is small for now, we could bump this up later once confident in cloudflare's cache purge workflow
      },
      logStatement: makeUploadPathHtml,
      subdir: null,
    })
  );

  return Promise.all(promises);
}

function doUpload() {
  var uploader;
  if ('s3' === reportUploader) {
    uploader = s3uploader({
      bucket: s3Subdir,
    });
  }
  if ('local' === reportUploader) {
    uploader = localUploader
    uploader.needsHeadersJson = true
  }
  return deploy(uploader);
}

gulp.task("deploy_TO_PRODUCTION", ["prodConfig", "dist"], function () {
  doUpload().catch((err) => {
    console.error(err);
  });
});

gulp.task("deployPreprod", ["preprodConfig", "dist"], function () {
  doUpload().catch((err) => {
    console.error(err);
  });
});

gulp.task("fontsPreprod", ["preprodConfig"], function () {
  return deployFonts({
    bucket: "preprod.pol.is",
  });
});

gulp.task("fontsProd", ["prodConfig"], function () {
  return deployFonts({
    bucket: "pol.is",
  });
});

function deployFonts(params) {
  var creds = JSON.parse(fs.readFileSync(".polis_s3_creds_client.json"));
  creds = _.extend(creds, params);

  //var fontCacheSeconds = 31536000;
  var fontCacheSeconds = 99;

  function makeUploadPathFactory(tagForLogging) {
    return function (file) {
      var fixed = file.path.match(RegExp("font.*"))[0];
      console.log("upload path " + tagForLogging + ": " + fixed);
      return fixed;
    };
  }

  ["woff", "woff2", "otf", "ttf", "svg", "eot"].forEach(function (ext) {
    var contentType = {
      woff: "application/x-font-woff",
      woff2: "application/font-woff2",
      ttf: "application/x-font-ttf",
      otf: "application/x-font-opentype",
      svg: "image/svg+xml",
      eot: "application/vnd.ms-fontobject",
    }[ext];

    gulp.src(["./font/*." + ext], { read: false }).pipe(
      s3(creds, {
        delay: 1000,
        headers: {
          "x-amz-acl": "public-read",
          "Content-Type": contentType,
          "Cache-Control": "no-transform,public,max-age=MAX_AGE,s-maxage=MAX_AGE".replace(
            /MAX_AGE/g,
            fontCacheSeconds
          ),
        },
        makeUploadPath: makeUploadPathFactory("cached_gzipped_" + fontCacheSeconds),
      })
    );
  });
}

var tasks = process.argv.slice(2);
gulp.start.apply(gulp, tasks);
