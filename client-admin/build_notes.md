# Build Notes

## Old Webpack Config Functionality

This webpack configuration:

1. **Entry/Output Configuration**
   - Entry point: `./src/index`
   - Output to `build` directory with optional chunkhashing for production
   - Cleans build directory between builds

2. **Bundling and Processing**
   - Resolves JS, CSS, PNG, and SVG files
   - Processes JS with Babel (React and ES6+ support)
   - Handles image files and MDX content

3. **HTML Generation**
   - Uses `public/index.ejs` as template
   - Creates different HTML filenames based on environment
   - Injects scripts into the body
   - Configures Twitter widgets and Facebook App ID

4. **Optimization**
   - Uses Lodash module replacement for tree-shaking
   - Minifies code in production with TerserPlugin
   - Compresses JS files in production

5. **Development Features**
   - Configures dev server with history API fallback
   - Has commented-out API proxy configuration

6. **Production Features**
   - Adds cache control headers via `.headersJson` files
   - Implements proper content encoding markers
   - Outputs different filenames in production

7. **Utilities**
   - Optional bundle analyzer via CLI flag
   - Copies static assets from public directory
   - Provides environment variable access

8. **Deployment Support**
   - Generates appropriate headers for JS (caching)
   - Generates appropriate headers for HTML (no-cache)
   - Handles file compression for production builds

## New Webpack Config Functionality

### Production Build

The new "prod" webpack configuration should:

1. **Entry/Output Configuration**
   - Entry point: `./src/index`
   - Output to `build` directory with optional chunkhashing for production
   - Cleans build directory between builds

2. **Bundling and Processing**
   - Resolves JS, CSS, and MD files
   - Processes JS with Babel (React and ES6+ support)

3. **HTML Generation**
   - Uses `public/index.html` as template
   - Injects scripts into the body
   - outputs to `build/index_admin.html`

4. **Optimization**
   - Minifies code in production
   - Compresses JS files in production

5. **Header Files**
   - Adds cache control headers via `.headersJson` files
   - Implements proper content encoding markers

6. **Assets**
   - Copies static assets from public directory
   - Copies `favicon.ico` to `build` directory

### Development Build

The new "dev" webpack configuration should:

1. **Dev Server**
   - Configures and runs a dev server
   - Proxies API requests to the backend server (usually `localhost:5000`)

2. **Hot Module Replacement**
   - Enables HMR for faster development
   - Updates the browser when code changes

3. **HTML Generation**
   - Uses `public/index.html` as template
   - Injects scripts into the body
   - outputs to `build/index.html`

### Deprecated Features

No longer needed:

- ejs templates
- svg/png files
- mdx processing
- bundle analyzer
- twitter widgets
- facebook app id
