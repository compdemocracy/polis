const path = require("path");
const webpack = require("webpack");
const CopyPlugin = require("copy-webpack-plugin");
const CompressionPlugin = require("compression-webpack-plugin");
const HtmlWebPackPlugin = require("html-webpack-plugin");
const EventHooksPlugin = require("event-hooks-webpack-plugin");
const lodashTemplate = require("lodash/template");
const glob = require("glob");
const fs = require("fs");
const pkg = require("./package.json");
const TerserPlugin = require("terser-webpack-plugin");
const Dotenv = require("dotenv-webpack");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

const outputDirectory = "dist";

/**
 * Generates .headersJson files alongside files served by the file-server. Reading these files instructs file-server
 * what HTML headers should be added to each file.
 *
 * @deprecated
 */
function writeHeadersJsonForOutputFiles(isDev) {
  function writeHeadersJson(matchGlob, headersData = {}) {
    // Handle both string and array glob patterns
    const patterns = Array.isArray(matchGlob) ? matchGlob : [matchGlob];
    patterns.forEach((pattern) => {
      const files = glob.sync(path.resolve(__dirname, outputDirectory, pattern));
      files.forEach((f) => {
        const headersFilePath = f + ".headersJson";
        fs.writeFileSync(headersFilePath, JSON.stringify(headersData));
      });
    });
  }

  // HTML files
  writeHeadersJson("*.html", {
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "no-cache"
  });

  // JavaScript files
  writeHeadersJson(["js/*.js", "*.js"], {
    ...(!isDev && { "Content-Encoding": "gzip" }),
    "Content-Type": "application/javascript",
    "Cache-Control": "no-transform,public,max-age=31536000,s-maxage=31536000"
  });

  // CSS files
  writeHeadersJson("css/*.css", {
    ...(!isDev && { "Content-Encoding": "gzip" }),
    "Content-Type": "text/css",
    "Cache-Control": "no-transform,public,max-age=31536000,s-maxage=31536000"
  });

  // Misc files
  writeHeadersJson("favicon.ico", {
    "Content-Type": "image/vnd.microsoft.icon"
  });
}

module.exports = (env, options) => {
  const isDevBuild = options.mode === "development";
  const isDevServer = process.env.WEBPACK_SERVE;
  const isTest = process.env.TEST;

  console.log({ isDevBuild, isDevServer, isTest });

  // Load environment variables based on the mode
  let dotEnvPath = ".env";
  if (isTest) {
    dotEnvPath = ".env.test";
  }

  // Log the environment file being used (if it exists)
  if (fs.existsSync(dotEnvPath)) {
    console.log(`Using environment file: ${dotEnvPath}`);
    require("dotenv").config({ path: dotEnvPath });
  } else {
    console.log(`Environment file ${dotEnvPath} not found, using system environment variables`);
  }

  // Get environment variables with defaults
  const apiUrl = process.env.API_URL || "http://localhost:5000";
  const conversationId = process.env.CONVERSATION_ID;
  const embedServiceHostname = process.env.EMBED_SERVICE_HOSTNAME || "pol.is";
  const gaTrackingId = process.env.GA_TRACKING_ID;
  const oidcCacheKeyPrefix = process.env.OIDC_CACHE_KEY_PREFIX || "oidc.user";
  const oidcCacheKeyIdTokenSuffix = process.env.OIDC_CACHE_KEY_ID_TOKEN_SUFFIX || "@@user@@";
  const port = process.env.PORT || 3001;

  // Log important configuration values
  console.log(`API URL: ${apiUrl}`);
  if (conversationId) {
    console.log(`Conversation ID: ${conversationId}`);
  }

  return {
    entry: ["./js/main", "./css/polis_main.scss"],

    // Control console output during build
    stats: {
      logging: isDevBuild ? "info" : "error",
      warnings: false,
      errors: true,
      errorDetails: true
    },

    output: {
      publicPath: "/",
      // Generate hashed filenames in production for cache busting
      filename: isDevBuild ? "js/[name].bundle.js" : `js/participation_bundle.[chunkhash:8].js`,
      path: path.resolve(__dirname, outputDirectory),
      clean: true,
      // Asset naming
      assetModuleFilename: "assets/[name].[hash:8][ext]"
    },

    // Module resolution
    resolve: {
      extensions: [".js", ".css", ".png", ".svg"],
      alias: {
        // The following modules need deep importing of JS files
        handlebars: path.resolve(__dirname, "node_modules/handlebars/dist/cjs/handlebars.runtime.js"),
        handlebones: path.resolve(__dirname, "node_modules/handlebones/handlebones"),
        deepcopy: path.resolve(__dirname, "node_modules/deepcopy/build/deepcopy.js")
      },
      fallback: {
        util: require.resolve("util/")
      }
    },

    // Development server configuration
    devServer: {
      // Serve static files from public directory
      static: {
        directory: path.join(__dirname, "public")
      },

      // Enable hot module replacement
      hot: true,

      // Enable history API fallback for SPA
      historyApiFallback: true,

      // Enable gzip compression
      compress: true,

      // Port to use
      port,

      // Open browser automatically (with conversation ID if available)
      open: isTest ? false : conversationId ? `http://localhost:${port}/${conversationId}` : true,

      // Client overlay configuration
      client: {
        overlay: {
          errors: true,
          warnings: false
        },
        logging: "error"
      },

      // Write files to disk for inspection
      devMiddleware: {
        writeToDisk: true,
        publicPath: "/"
      },

      // API proxying - disabled during tests
      ...(isTest
        ? {}
        : {
            proxy: [
              {
                context: ["/api"],
                target: apiUrl,
                changeOrigin: true,
                logLevel: "debug",
                pathRewrite: { "^/api": "/api" },
                secure: false
              }
            ]
          })
    },

    // Source maps configuration
    devtool: isDevBuild ? "eval-source-map" : false,

    plugins: [
      // Load environment variables
      new Dotenv({
        path: dotEnvPath,
        systemvars: true,
        defaults: true,
        safe: false,
        allowEmptyValues: true,
        debug: isDevBuild
      }),

      // Define some globals
      new webpack.ProvidePlugin({
        process: "process/browser"
      }),

      new CopyPlugin({
        patterns: [
          { from: "public", globOptions: { ignore: ["**/index.ejs"] } },
          { from: "api", globOptions: { ignore: ["**/embed.js"] } },
          {
            from: "api/embed.js",
            transform(content, _absoluteFrom) {
              return lodashTemplate(content.toString())({
                embedServiceHostname
              });
            }
          },
          {
            from: "node_modules/font-awesome/fonts/**/*",
            to: "./fonts/[name][ext]"
          }
        ]
      }),

      new HtmlWebPackPlugin({
        template: path.resolve(__dirname, "public/index.ejs"),
        filename: "index.html",
        templateParameters: {
          versionString: pkg.version,
          gaTrackingId: gaTrackingId,
          oidcCacheKeyPrefix: oidcCacheKeyPrefix,
          oidcCacheKeyIdTokenSuffix: oidcCacheKeyIdTokenSuffix,
          process: {
            env: {
              NODE_ENV: options.mode
            }
          }
        },
        inject: true,
        minify: !isDevBuild && {
          removeComments: true,
          collapseWhitespace: true,
          removeRedundantAttributes: true,
          useShortDoctype: true,
          removeEmptyAttributes: true,
          removeStyleLinkTypeAttributes: true,
          keepClosingSlash: true,
          minifyJS: true,
          minifyCSS: true,
          minifyURLs: true
        }
      }),

      new webpack.DefinePlugin({
        "process.env.GA_TRACKING_ID": JSON.stringify(gaTrackingId),
        "process.env.OIDC_CACHE_KEY_PREFIX": JSON.stringify(oidcCacheKeyPrefix),
        "process.env.OIDC_CACHE_KEY_ID_TOKEN_SUFFIX": JSON.stringify(oidcCacheKeyIdTokenSuffix)
      }),

      // Add preload data in development mode if conversation ID exists
      ...(isDevBuild && conversationId
        ? [
            new (require("./setup/preload-html-plugin"))({
              conversationId,
              apiUrl,
              isTest
            })
          ]
        : []),

      // Extract CSS to separate file in production only
      ...(!isDevBuild
        ? [
            new MiniCssExtractPlugin({
              filename: "css/polis.css"
            })
          ]
        : []),

      // Generate the .headersJson files in production only
      ...(!isDevBuild && !isDevServer
        ? [
            new EventHooksPlugin({
              afterEmit: () => {
                console.log("Writing *.headersJson files...");
                writeHeadersJsonForOutputFiles(false);
              }
            })
          ]
        : []),

      // Only compress files during production builds.
      ...(isDevBuild || isDevServer
        ? []
        : [
            new CompressionPlugin({
              test: /\.(js|css)$/,
              filename: "[path][base]",
              deleteOriginalAssets: true
            })
          ])
    ],

    // Optimization settings
    optimization: {
      // Only minify during production builds
      minimize: !isDevBuild,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            format: {
              comments: false
            },
            compress: {
              // Keep console.log statements in production builds
              drop_console: false
            }
          },
          extractComments: false
        })
      ],

      // Code splitting
      splitChunks: {
        chunks: "all",
        name: false,
        cacheGroups: {
          // Bundle core dependencies separately
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: "vendors",
            chunks: "all",
            priority: -10
          }
        }
      },

      // Runtime chunk
      runtimeChunk: {
        name: "runtime"
      }
    },

    module: {
      rules: [
        {
          test: /\.(handlebars|hbs)$/,
          exclude: /node_modules/,
          loader: "handlebars-loader",
          options: {
            ignorePartials: true // We load partials at runtime so ignore at compile-time
          }
        },
        {
          test: /\.m?js$/,
          exclude: [/node_modules/],
          use: {
            loader: "babel-loader",
            options: {
              presets: ["@babel/preset-env", "@babel/react"],
              cacheDirectory: true
            }
          }
        },
        // Images (using Asset Modules instead of file-loader)
        {
          test: /\.(png|jpg|gif|svg)$/,
          exclude: /node_modules/,
          type: "asset/resource",
          generator: {
            filename: "images/[name].[hash:8][ext]"
          }
        },
        {
          test: /\.mdx?$/,
          exclude: /node_modules/,
          use: ["babel-loader", "@mdx-js/loader"]
        },
        // SCSS files - use style-loader in dev, extract in production
        {
          test: /\.s[ac]ss$/,
          exclude: /node_modules/,
          use: [
            // In development, inject styles via JS; in production, extract to file
            isDevBuild ? "style-loader" : MiniCssExtractPlugin.loader,
            // Process CSS
            "css-loader",
            // Process SCSS
            "sass-loader"
          ]
        },
        // Shims for older modules
        {
          test: /d3-tip/,
          use: {
            loader: "babel-loader",
            options: {
              presets: ["@babel/preset-env", "@babel/react"],
              sourceType: "module" // d3-tip uses ES6 modules
            }
          }
        },
        {
          test: /deepcopy/,
          use: {
            loader: "babel-loader",
            options: {
              presets: ["@babel/preset-env", "@babel/react"],
              sourceType: "script" // set 'this' to 'window'
            }
          }
        },
        {
          test: /bootstrap\/(transition|button|tooltip|affix|dropdown|collapse|popover|tab|alert)/,
          use: [
            {
              loader: "imports-loader",
              options: {
                imports: [
                  // Expects jQuery to be present
                  "default jquery jQuery"
                ]
              }
            }
          ]
        },
        {
          test: /backbone\/backbone$/,
          use: [
            {
              loader: "imports-loader",
              options: {
                imports: [
                  // Expects jQuery and lodash to be present
                  "default jquery $",
                  "default lodash _"
                ]
              }
            }
          ]
        },
        {
          test: /handlebones$/,
          use: [
            {
              loader: "imports-loader",
              options: {
                imports: [
                  // Expects lodash, Backbone and handlebars to be present
                  "default handlebars Handlebars",
                  "default backbone Backbone",
                  "default lodash _"
                ]
              }
            }
          ]
        }
      ]
    }
  };
};
