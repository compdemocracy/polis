/* eslint-env browser */
// Copied into each independently built client and the server. The parity test
// keeps these dependency-free copies identical.
// prettier-ignore
void (function (root) {
  // Generated from the route census and static path table by ci/local/client-error-paths.cjs.
  var words =
    '__webpack_hmr _astro about acceptInvite account admin admin_bundle.js all_conversations alpha answers api assets auth batchReports beeswarm.png bg2050.png bg2050_fr.png bg_collective.png bg_map.png bid bidToPid bot build-info.json cached choices clientErrors close collective collective.png collectiveStatement collectiveStatements comments comments-bulk commentsReport company consensus contexts contrib convSubscriptions conversation conversationStats conversationUuid conversations create createuser css csv delphi demo dist domainWhitelist donate einvites embed embed.html embed.js embedPreprod embedPreprod.html embedPreprod.js embedReport embedReport.html embedReportPreprod embedReportPreprod.html explore exportReport export_links.png famous favicon.ico feeds font fonts football gov hierarchy hk home iim iip images inbox inboxApiTest index.html index_admin.html index_report.html inputs integrate invites jobs js locations login logout logs m math me metadata moderate myInvites nabi narrativeReport nextComment notifications ops ot other-conversations owner page participants participants_extended participation participationInit pca2 pdf perfStats_9182738127 polis_site_id preload privacy proximity ptptCommentMod ptptois pwreset query_participants_by_metadata questions recent_activity recently_started reopen report reportCommentSelections reportExport reportNarrative report_bundle report_style report_vendor_ reports reserve_conversation_id results robots.txt s selections sendCreatedLinkToEmail settings share signin signout stars statements static stats styleguide subscribe summary testConnection testDatabase topicAgenda topicHierarchy topicMapNarrativeReport topicMod topicPrioritize topicReport topicStats topics topicsVizReport tos translations trashes treevite twemoji unsubscribe upvotes user users v3 verify version visualizations votes votes-bulk waves whoami xid xidAllowList xids zinvites'.split(
      ' '
    )
  // Resource URLs from another origin are reduced to a host-only marker.
  function resourcePath(value) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      try {
        var url = new URL(value.slice(0, 2048))
        var marker = url.protocol + '//' + url.hostname
        return marker.length <= 160 ? marker : ''
      } catch {
        return ''
      }
    }
    return path(value)
  }
  function path(value) {
    if (typeof value !== 'string') return ''
    value = value
      .slice(0, 2048)
      .replace(/^https?:\/\/[^/]+/i, '')
      .split(/[?#]/)[0]
    if (value.charAt(0) !== '/') return ''
    // Only the public Twemoji files shipped with the admin client keep their names.
    var emoji = value.match(/^\/twemoji\/14\.0\.2\/72x72\/([a-f0-9-]+)\.png$/)
    var emojiNames =
      '1f1fa-1f1f8 1f30d 1f30e 1f30f 1f3ce 1f44b 1f479 1f47e 1f4be 1f4d6 1f529 1f5de 2697 26a1 2764'.split(
        ' '
      )
    if (emoji && emojiNames.indexOf(emoji[1]) !== -1) return value
    if (
      /^\/(?:_astro|js|static|assets)\/[A-Za-z0-9_./-]+\.(?:js|mjs|css)$/.test(value) ||
      /^\/report_(?:bundle|vendor)[A-Za-z0-9_.-]*\.js$/.test(value)
    )
      return value.slice(0, 160)
    return value
      .split('/')
      .slice(0, 12)
      .map(function (part) {
        return part === '' || words.indexOf(part) !== -1 ? part : ':id'
      })
      .join('/')
      .slice(0, 160)
  }
  function message(value, kind) {
    if (typeof value !== 'string') value = ''
    value = value.slice(0, 2048)
    if (['Network error', 'SyntaxError: Invalid JSON', 'Script error.'].indexOf(value) !== -1)
      return value
    var status = value.match(/\b(?:HTTP(?: error!? status:)?|status)\s*([1-5][0-9]{2})\b/i)
    if (kind === 'fetch' || kind === 'xhr')
      return status ? 'HTTP ' + status[1] : 'Request failed'
    if (/Cannot read (?:properties|property) of (?:undefined|null)/.test(value))
      return (
        'TypeError: Cannot read properties of ' + (/of null/.test(value) ? 'null' : 'undefined')
      )
    if (/Failed to fetch|NetworkError|Network request failed|Load failed/.test(value))
      return 'Network error'
    if (/Unexpected token|Unexpected end of JSON|JSON\.parse/.test(value))
      return 'SyntaxError: Invalid JSON'
    var react = value.match(/Minified React error #([0-9]{1,4})\b/)
    if (react) return 'Minified React error #' + react[1]
    if (/Maximum call stack size exceeded|too much recursion/.test(value))
      return 'RangeError: Maximum call stack size exceeded'
    var type = value.match(
      /^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/
    )
    return type ? type[1] : 'Error'
  }
  function stack(value, page) {
    if (typeof value !== 'string') return ''
    var lines = value.slice(0, 8192).split('\n').slice(0, 12)
    var v8 = lines.some(function (line) { return /^\s*at /.test(line) })
    var documentFrame = false
    var scripts = lines.map(function (line) {
      // Bound work before parsing, including on the server's event loop.
      if (line.length > 1024) return ''
      line = line.trim()
      // Already projected document markers must survive receiver projection.
      if (!v8 && line === page) {
        documentFrame = true
        return ''
      }
      if (line.indexOf('at ') === 0) {
        line = line.slice(3)
        var open = line.lastIndexOf('(')
        if (open !== -1 && line.endsWith(')')) line = line.slice(open + 1, -1)
      } else {
        // V8 message lines are never frames, even when they end in a location.
        if (v8) return ''
        // Firefox function names may include '/', e.g. handleVote/<@URL.
        var at = line.indexOf('@')
        if (at >= 0 && !line.slice(0, at).includes(':'))
          line = line.slice(at + 1)
      }
      // Anchored at the frame location: never search inside unsupported schemes
      // or message text. A single URL scan and bounded numeric suffixes are linear.
      var frame = line.match(/^((?:https?:\/\/|\/)[^\s()]+):(\d{1,8}):(\d{1,8})$/)
      if (!frame) return ''
      var source = path(frame[1])
      if (source && source.indexOf(':id') === -1 && /\.(?:js|mjs)$/.test(source))
        return source + ':' + frame[2] + ':' + frame[3]
      // Server-rendered content can shift both line and column. Never transmit
      // document coordinates, including those on apparently static pages.
      if (source && source === page) documentFrame = true
      return ''
    }).filter(Boolean)
    // The prelude's fetch/XHR wrappers live in the document. Excluding document
    // frames whenever bundle frames exist keeps callers as the grouping location.
    // Inline-only errors retain a page marker, with no content-dependent numbers.
    return scripts.length ? scripts.join('\n').slice(0, 1024) : documentFrame ? page : ''
  }
  var kinds = [
    'error',
    'unhandledrejection',
    'console_error',
    'console_warn',
    'fetch',
    'xhr',
    'resource',
    'csp'
  ]
  var methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']
  function integer(value, maximum) {
    return typeof value === 'number' && isFinite(value)
      ? Math.max(0, Math.min(maximum, Math.floor(value)))
      : 0
  }
  function signatureLocation(value) {
    // Build hashes may change; positions must still distinguish errors on a page.
    return value.replace(/\.[A-Za-z0-9_-]{8,}(\.(?:js|mjs|css))(:\d+:\d+)?$/, '$1$2')
  }
  function signature(data) {
    var value = [
      data.client,
      data.kind,
      data.status || data.message,
      signatureLocation(data.stack.split('\n')[0] || data.resource)
    ].join('\n')
    var a = 2166136261,
      b = 5381
    for (var i = 0; i < value.length; i++) {
      a = Math.imul(a ^ value.charCodeAt(i), 16777619)
      b = Math.imul(b ^ value.charCodeAt(i), 33)
    }
    return (
      ('00000000' + (a >>> 0).toString(16)).slice(-8) +
      ('00000000' + (b >>> 0).toString(16)).slice(-8)
    )
  }
  function fields(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      ['alpha', 'admin', 'report', 'participation'].indexOf(input.client) === -1 ||
      kinds.indexOf(input.kind) === -1
    )
      return null
    var network = input.kind === 'fetch' || input.kind === 'xhr'
    var method = typeof input.method === 'string' ? input.method.toUpperCase() : ''
    var data = {
      client: input.client,
      build:
        typeof input.build === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.build)
          ? input.build
          : 'unknown',
      page: path(input.page),
      kind: input.kind,
      message: message(input.message, input.kind).slice(0, 256),
      stack: stack(input.stack, path(input.page)),
      resource: resourcePath(input.resource),
      method: network && methods.indexOf(method) !== -1 ? method : '',
      status:
        network && input.status >= 0 && input.status <= 599 ? integer(input.status, 599) : 0,
      duration_ms: network ? integer(input.duration_ms, 60000) : 0,
      signature: '',
      count: Math.max(1, integer(input.count, 1000))
    }
    data.signature = signature(data)
    return data
  }
  function install(options) {
    var noop = function () {}
    try {
      var win = options.window || root
      if (!win || ['alpha', 'admin', 'report', 'participation'].indexOf(options.client) === -1)
        return noop
      var base = new URL(options.apiBase || '/', win.location.href)
      if (
        base.origin !== win.location.origin ||
        !/^https?:$/.test(base.protocol) ||
        base.username ||
        base.password
      )
        return noop
      var endpoint = new URL('/api/v3/clientErrors', base).href
      var installed = win.__polisClientErrorReporters || (win.__polisClientErrorReporters = {})
      if (installed[options.client]) return installed[options.client]
      var originalFetch = win.fetch
      var pending = {},
        distinct = 0,
        timer = null,
        busy = false
      // Across reloads and clients in this tab: 20 sends per minute, 200 per session.
      // Each page keeps at most 50 signatures; repeats carry unsent occurrence counts.
      var storageKey = 'polis-client-errors-rate'
      var rate = { start: Date.now(), sent: 0, total: 0 }
      var allowance = function () {
        var now = Date.now()
        try {
          var saved = JSON.parse(win.sessionStorage.getItem(storageKey))
          if (
            saved &&
            typeof saved.start === 'number' &&
            typeof saved.sent === 'number' &&
            typeof saved.total === 'number'
          )
            rate = saved
        } catch {
          /* Storage is optional; the in-memory limits still apply. */
        }
        if (now - rate.start >= 60000 || now < rate.start) {
          rate.start = now
          rate.sent = 0
        }
        return rate.total < 200 && rate.sent < 20
      }
      var schedule = function (delay) {
        if (timer !== null || typeof win.setTimeout !== 'function') return
        timer = win.setTimeout(function () {
          timer = null
          flush()
        }, delay)
      }
      var transmit = function (data) {
        if (!allowance()) return false
        rate.sent++
        rate.total++
        try {
          win.sessionStorage.setItem(storageKey, JSON.stringify(rate))
        } catch {
          /* Optional storage. */
        }
        var body = JSON.stringify(data),
          sent = false
        try {
          if (win.navigator && win.navigator.sendBeacon)
            sent = win.navigator.sendBeacon(
              endpoint,
              new Blob([body], { type: 'text/plain;charset=UTF-8' })
            )
        } catch {
          /* Try the original fetch below. */
        }
        if (!sent && typeof originalFetch === 'function') {
          try {
            Promise.resolve(
              originalFetch.call(win, endpoint, {
                method: 'POST',
                body: body,
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                redirect: 'error',
                keepalive: true
              })
            ).catch(noop)
          } catch {
            /* Transport failures never enter the reporter. */
          }
        }
        return true
      }
      var flush = function () {
        if (busy) return
        busy = true
        try {
          Object.keys(pending).forEach(function (key) {
            var data = pending[key]
            if (data.count && transmit(data)) data.count = 0
          })
          if (
            rate.total < 200 &&
            Object.keys(pending).some(function (key) {
              return pending[key].count > 0
            })
          )
            schedule(Math.max(1000, 60000 - (Date.now() - rate.start)))
        } catch {
          /* Reporting must not affect the application. */
        }
        busy = false
      }
      var report = function (kind, error, resource, details) {
        if (busy) return
        busy = true
        try {
          if (typeof resource === 'string' && resource) {
            var resourceUrl = new URL(resource, win.location.href)
            resource = /^https?:$/.test(resourceUrl.protocol)
              ? resourceUrl.origin === win.location.origin
                ? resourceUrl.pathname
                : resourceUrl.origin
              : ''
            if (resource === '/api/v3/clientErrors') return
          }
          details = details || {}
          var data = fields({
            client: options.client,
            build: options.build,
            page: win.location.pathname,
            kind: kind,
            message:
              error && typeof error.message === 'string'
                ? error.message
                : typeof error === 'string'
                ? error
                : '',
            stack: error && typeof error.stack === 'string' ? error.stack : '',
            resource: resource,
            method: details.method,
            status: details.status,
            duration_ms: details.duration_ms
          })
          if (!data) return
          var prior = pending[data.signature]
          if (prior) {
            prior.count = Math.min(1000, prior.count + 1)
            prior.duration_ms = Math.max(prior.duration_ms, data.duration_ms)
            schedule(1000)
          } else if (distinct < 50) {
            distinct++
            pending[data.signature] = data
            if (transmit(data)) data.count = 0
            else schedule(Math.max(1000, 60000 - (Date.now() - rate.start)))
          }
        } catch {
          /* Reporting must not affect the application. */
        } finally {
          busy = false
        }
      }
      installed[options.client] = report
      var listen = function (target, name, callback, capture) {
        try {
          target.addEventListener(name, callback, capture)
        } catch {
          /* Optional browser API. */
        }
      }
      listen(
        win,
        'error',
        function (event) {
          try {
            var target = event.target
            if (target && target !== win && target.tagName)
              report('resource', '', target.currentSrc || target.src || target.href)
            else {
              var error = event.error
              var frames = error && typeof error.stack === 'string' ? error.stack : ''
              // A thrown primitive may have coordinates but no Error object.
              // Use the browser's location; never invent a reporting-handler stack.
              if (
                !frames &&
                typeof event.filename === 'string' &&
                Number.isInteger(event.lineno) &&
                event.lineno > 0 &&
                event.lineno <= 99999999 &&
                Number.isInteger(event.colno) &&
                event.colno > 0 &&
                event.colno <= 99999999
              )
                frames = event.filename + ':' + event.lineno + ':' + event.colno
              report(
                'error',
                {
                  message:
                    error && typeof error.message === 'string' ? error.message : event.message,
                  stack: frames
                },
                event.filename
              )
            }
          } catch {
            /* Optional event properties. */
          }
        },
        true
      )
      listen(win, 'unhandledrejection', function (event) {
        try {
          report('unhandledrejection', event.reason)
        } catch {
          /* Optional event properties. */
        }
      })
      listen(win, 'securitypolicyviolation', function (event) {
        try {
          report('csp', '', event.blockedURI)
        } catch {
          /* Never read the CSP sample. */
        }
      })
      listen(win, 'pagehide', flush)
      if (win.document)
        listen(win.document, 'visibilitychange', function () {
          try {
            if (win.document.visibilityState === 'hidden') flush()
          } catch {
            /* Optional browser API. */
          }
        })
      // FontFaceSet failures do not consistently dispatch a window resource event.
      if (win.document && win.document.fonts)
        listen(win.document.fonts, 'loadingerror', function () {
          report('resource', '')
        })
      ;['error', 'warn'].forEach(function (level) {
        try {
          var original = win.console && win.console[level]
          if (typeof original !== 'function') return
          win.console[level] = function () {
            // Only classify the format string. Substitutions and objects may be private.
            try {
              var frames = (new Error().stack || '').split('\n')
              // Engines either include an error header or start with the wrapper frame.
              var skip = /:\d+:\d+\)?$/.test(frames[0]) ? 1 : 2
              report('console_' + level, {
                message: typeof arguments[0] === 'string' ? arguments[0] : '',
                stack: frames.slice(skip).join('\n')
              })
            } catch {
              /* Optional console. */
            }
            return original.apply(this, arguments)
          }
        } catch {
          /* A read-only console must continue working. */
        }
      })
      var requestInfo = function (input, init) {
        try {
          return {
            resource:
              typeof input === 'string'
                ? input
                : input && typeof input.url === 'string'
                ? input.url
                : input instanceof URL
                ? input.href
                : '',
            method: (init && init.method) || (input && input.method) || 'GET'
          }
        } catch {
          return { resource: '', method: '' }
        }
      }
      try {
        if (typeof originalFetch === 'function')
          win.fetch = function (input, init) {
            var info = requestInfo(input, init),
              started = Date.now(),
              result
            function failed(status) {
              report('fetch', status ? 'HTTP ' + status : '', info.resource, {
                method: info.method,
                status: status,
                duration_ms: Date.now() - started
              })
            }
            try {
              result = originalFetch.apply(this, arguments)
            } catch (error) {
              failed(0)
              throw error
            }
            return result.then(
              function (response) {
                try {
                  if (response.status === 0 || response.status >= 400) failed(response.status)
                } catch {
                  /* Preserve response. */
                }
                return response
              },
              function (error) {
                failed(0)
                throw error
              }
            )
          }
      } catch {
        /* A read-only fetch must continue working. */
      }
      try {
        var prototype = win.XMLHttpRequest && win.XMLHttpRequest.prototype
        if (prototype) {
          var originalOpen = prototype.open,
            originalSend = prototype.send
          var requests = typeof WeakMap === 'function' ? new WeakMap() : null
          if (requests) {
            prototype.open = function (method, resource) {
              var result = originalOpen.apply(this, arguments)
              try {
                requests.set(this, {
                  method: method,
                  resource: typeof resource === 'string' ? resource : '',
                  started: 0,
                  complete: false
                })
              } catch {
                /* Optional metadata. */
              }
              return result
            }
            prototype.send = function () {
              var info = requests.get(this),
                complete = noop
              if (info) {
                info.started = Date.now()
                complete = function (failed) {
                  try {
                    if (info.complete) return
                    info.complete = true
                    try {
                      this.removeEventListener('loadend', onEnd)
                      this.removeEventListener('error', onError)
                      this.removeEventListener('timeout', onError)
                    } catch {
                      /* Optional event removal. */
                    }
                    var status = this.status
                    if (failed || status === 0 || status >= 400)
                      report('xhr', status ? 'HTTP ' + status : '', info.resource, {
                        method: info.method,
                        status: status,
                        duration_ms: Date.now() - info.started
                      })
                  } catch {
                    /* Preserve XHR events. */
                  }
                }.bind(this)
                var onEnd = function () {
                    complete(false)
                  },
                  onError = function () {
                    complete(true)
                  }
                listen(this, 'loadend', onEnd)
                listen(this, 'error', onError)
                listen(this, 'timeout', onError)
              }
              try {
                return originalSend.apply(this, arguments)
              } catch (error) {
                if (info) complete(true)
                throw error
              }
            }
          }
        }
      } catch {
        /* Optional or read-only XHR API. */
      }
      return report
    } catch {
      return noop
    }
  }
  var api = { install: install, fields: fields, signature: signature }
  // CommonJS exists in Node and webpack; the plain browser script has no module.
  // eslint-disable-next-line no-undef
  if (typeof module !== 'undefined') module.exports = api
  if (root) root.PolisClientErrors = api
})(typeof window === 'undefined' ? null : window)
