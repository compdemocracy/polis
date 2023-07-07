// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

const exec = require("child_process").exec;
const gulp = require("gulp");
const glob = require("glob");
const rename = require("gulp-rename");
const gzip = require("gulp-gzip");
const path = require("path");
const Promise = require("es6-promise").Promise;
const fs = require("fs");
const rimraf = require("rimraf");
const runSequence = require("run-sequence");

const localOutputPath = './build';
const staticFilesPrefix = "cached";
const baseDistRoot = "dist";
let destRootBase = "devel";
let destRootRest = "/"; // in dist, will be the cachebuster path prefix
let versionString = "VERSION_ERROR";

function destRoot() {
  return path.join(destRootBase, destRootRest);
}

function getGitHash() {
  return new Promise(function (resolve/*, reject*/) {
    if (process.env.GIT_HASH) {
      resolve(process.env.GIT_HASH);
    } else {
      console.log("No GIT_HASH provided. Skipping use.");
      resolve();
    }
  });
}

function localUploader(params) {
  params.subdir = params.subdir || ''
  return gulp.dest(path.join(localOutputPath, params.subdir))
}

function deploy(uploader) {
  const cacheSecondsForContentWithCacheBuster = 31536000; // 1 year

  function makeUploadPathHtml(file) {
    return file.path.match(RegExp("[^/]*$"))[0];
  }

  function deployBatch({ srcKeep, srcIgnore, headers, subdir/*, logStatement*/ }) {
    return new Promise(function (resolve, reject) {
      const gulpSrc = [srcKeep];
      if (srcIgnore) {
        gulpSrc.push(srcIgnore);
      }
      function doDeployBatch() {
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
            console.error("Error uploading", err);
            reject(err);
          })
          .on("end", resolve);
      }
      // create .headersJson files
      if (uploader.needsHeadersJson) {
        const globOpts = {
          nodir: true,
        };
        if (srcIgnore) {
          globOpts.ignore = srcIgnore;
        }
        const files = glob.sync(srcKeep, globOpts);
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const headerFilename = file + ".headersJson";
          fs.writeFileSync(headerFilename, JSON.stringify(headers));
          gulpSrc.push(headerFilename);
        }
      }
      doDeployBatch();
    });
  }

  const promises = [];
  // Cached Files without Gzip
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
  const uploader = localUploader;
  uploader.needsHeadersJson = true;
  return deploy(uploader);
}

// Calculate the git hash and set the destRootRest and versionString variables.
gulp.task("configureForProduction", function (callback) {
  destRootBase = "dist";

  // NOTE using callback instead of returning a promise since the promise isn't doing the trick - haven't tried updating gulp yet.
  getGitHash()
    .then(function (hash) {
      const d = new Date();
      const tokenParts = [
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

      const unique_token = tokenParts.join("_");
      destRootRest = [staticFilesPrefix, unique_token].join("/");
      versionString = unique_token;

      callback(null);
    })
    .catch(function (err) {
      console.error("getGitHash err", err);
      callback(true);
    });
});

// Remove the dist folder.
gulp.task("cleanDist", function () {
  rimraf.sync(baseDistRoot);
});

// Build the report bundle with webpack.
gulp.task("bundle", [], function (callback) {
  exec("npm run bundle:prod", function (error/*, stdout, stderr*/) {
    callback(error);
  });
});

// Copy index.html to the dist folder with version and path string replacements.
gulp.task("index", [], function () {
  let index = fs.readFileSync("index.html", { encoding: "utf8" });
  index = index.replace(
    "/dist/report_bundle.js",
    "/" + [destRootRest, "js", "report_bundle.js"].join("/")
  );
  index = index.replace("NULL_VERSION", versionString);

  // index goes to the root of the dist folder.
  const indexDest = [destRootBase, "index_report.html"].join("/");
  fs.writeFileSync(indexDest, index);
});

// GZip the bundle js file to the dist folder with a .gz extension.
gulp.task("scripts", function () {
  const files = ["dist/report_bundle.js"];
  let s = gulp.src(files);
  s = s.pipe(gzip()).pipe(
    rename(function (path) {
      // remove .gz extension
      const ext = path.extname;
      path.extname = ext.substr(0, ext.length - ".gz".length);
    })
  );
  return s.pipe(gulp.dest(destRoot() + "/js"));
});

// Run all the tasks
gulp.task("dist", ["configureForProduction"], function (callback) {
  runSequence(
    "cleanDist",
    "bundle",
    "index",
    "scripts",
    callback
  );
});

gulp.task("build", ["dist"], function () {
  doUpload().catch((err) => { console.error(err); });
});
