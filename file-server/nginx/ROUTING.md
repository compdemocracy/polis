# Paths accepted by the edge proxy

Order matters: exact document locations, existing Rust route selections,
application locations, static locations, then the local 404. The alpha
prefixes retain their existing upstream and rewrite. Rust switches retain
their method and body conditions, timeouts and per-route fallback behavior.
With an empty `RUST_API_ROUTES`, all application entries below use Node.

“File-server” rows reach Node, which forwards the unchanged path to
`STATIC_FILES_HOST`: the file-server container in development, the static
asset origin in production, where the web boxes run no file-server. That
origin owns file bytes, header sidecars, ranges and conditional responses.
This change does not retire registered pages or APIs.
Paths proposed for retirement are listed here too because those registrations
still exist in this source tree.

| Path family | Destination after this change |
|---|---|
| `/alpha/*` (including `/alpha/embed.js`) | Alpha on port 4321; remove `/alpha` before forwarding |
| `/_astro/*` | Alpha on port 4321; preserve the path |
| `/api/*` (case insensitive) | Node, except the paths and methods explicitly selected by existing Rust switches |
| `/api/v3/clientErrors` | Node; POST browser error reports; handled before shared parsing, without authentication or database access |
| `/api/v3/{participationInit,nextComment,votes,votes/famous,comments,comments-bulk,votes-bulk}` | Same API selection; includes the live legacy famous-votes call and participation writes |
| `/api/v3/{conversations,owner,participants,ptptois,zinvites,einvites,treevite,users,auth,verify,notifications,sendCreatedLinkToEmail}*` | Same API selection |
| `/api/v3/{math,delphi,reports,reportExport,reportCommentSelections,collectiveStatement,topicStats,statements,topicMod}*` | Same API selection, including unchanged topic moderation |
| `/api/v3/{metadata,topicAgenda,participation,domainWhitelist,xids,xidAllowList,ops,version,testConnection,testDatabase}*` and other API paths | Same API selection; no API allowlist or method narrowing is introduced |
| Old or removed API names, including `tutorial`, `snapshot`, `dummyButton`, `notifyTeam`, `metrics`, `sendEmailExportReady`, `math/correlationMatrix`, `mathUpdate`, `contributors`, `auth/deregister`, `dataExport*`, `math/pca`, `users/invite`, `joinWithInvite`, social/payment integration names | Same API selection; application remains responsible for its existing result |
| `/perfStats_9182738127`, `/robots.txt` | Node, or their existing Rust switches; retain case-insensitive string-route forms |
| `/feeds/:reportId`, `/feeds/:reportId/{consensus,topics}` | Node |
| `/polis_site_id*` | Node; preserves the live external embed integration |
| `/iip/:id`, `/iim/:id` | Node, or their existing Rust switches |
| `/` | Node's conditional index handler |
| `/<id>`, `/explore/<id>`, `/share/<id>`, `/summary/<id>`, `/ot/<id>` | Node, or the corresponding existing Rust page switch; preserve suffix matching |
| `/demo/<id>` | Node |
| `/m/<id>*` | Node, or existing `adminPage` switch |
| `/integrate*`, `/other-conversations*` | Node, or the corresponding existing Rust page switch |
| `/account*`, `/conversations*`, `/signin*`, `/signout*`, `/home*` | Node; includes live sign-in, sign-out and landing pages |
| `/ops` and `/ops/*` | Node, or existing `opsPage` switch; application controls enablement |
| `/privacy`, `/tos`, `/donate` and their slash forms | Node; preserves linked legal and donation pages and slash redirects |
| `/conversation/create*`, `/user/{create,login,logout}`, `/settings` (and existing suffix forms) | Node, or the corresponding existing Rust page switch |
| `/bot*`, `/gov*`, `/createuser*`, `/contrib*`, `/inbox`, `/hk*`, `/s`, `/s/*`, `/inboxApiTest*`, `/pwreset*`, `/demo`, `/company` | Node; page retirement is separate |
| `/football`, `/pdf`, `/nabi`, `/about` and their slash forms | Node's redirects, or existing `about` switch |
| `/report/<id>`, `/narrativeReport/<id>`, `/stats/<id>`, `/commentsReport/<id>`, `/topicReport/<id>`, `/topicsVizReport/<id>`, `/topicHierarchy/<id>`, `/collectiveStatements/<id>`, `/exportReport/<id>`, `/topicMapNarrativeReport/<id>`, `/topicStats/<id>` | Node's report shell/preload handler; preserve optional `r` and suffix matching |
| `/embed`, `/embedPreprod`, `/embedReport`, `/embedReportPreprod`, `/styleguide`, `/dist/admin_bundle.js`, `/__webpack_hmr` | Node's existing registrations; page retirement is separate |
| `/embed.js`, `/embedPreprod.js` | File-server; the live legacy embed script bypasses Node |
| `/report_bundle*.js`, `/report_style*.css`, `/report_vendor_*.js`, including `.map`, `.gz`, `.LICENSE.txt`, `.headersJson` companions | File-server; includes report libraries loaded as browser globals |
| `/static/*` | Node, which serves them from `STATIC_FILES_HOST`; admin bundles, maps and versioned font CSS/font files |
| `/js/*`, `/css/*`, `/assets/*`, `/images/*`, `/fonts/*` | Node, which serves them from `STATIC_FILES_HOST`; participation bundles/styles, JWT library, images and Font Awesome |
| `/twemoji/*` | Node, which serves them from `STATIC_FILES_HOST`; versioned emoji images and their licence |
| `/{admin,participation,report}/build-info.json` and header sidecars | File-server |
| `/index.html`, `/index_admin.html`, `/index_report.html`, `/404.html`, `/embed.html`, `/embedPreprod.html`, `/embedReport.html`, `/embedReportPreprod.html` and header sidecars | File-server; exact `/404.html` takes precedence over numeric conversation regexes |
| `/favicon.ico`, `/bg_collective.png`, `/bg_map.png`, `/export_links.png`, `/bg2050.png`, `/bg2050_fr.png`, `/beeswarm.png`, `/collective.png` and header sidecars | File-server |
| `/cached/*`, `/font/*`, unmatched `/*embed*js/*` | Local 404; no current build emits assets into these old path families |
| Every remaining path, including unknown root JS/HTML names and old test-source directories | Local 404; neither Node nor file-server is called |

The access-log review identified `/embed.js`, both report asset patterns,
`/polis_site_id*`, `votes/famous`, sign-in/sign-out, `/home`, and the legal and
donation pages as live. All retain their final serving application. Asset
families also include the current build outputs, because a cached asset can
be live without an origin request during the review window. The table covers
path families, not a claim that every spelling or filename was observed.

A known static prefix can still return the static origin's 404, through Node, for a missing file.
Unknown paths outside those prefixes use the edge's local 404. API-prefix
misses still reach the application, as do broad registered page prefixes;
this preserves application routing until those routes are retired. Unknown
paths ending in a slash now return 404 instead of Node's catch-all redirect.
No database work, queueing, locks or admission checks are added to voting,
comment submission or next-statement requests.

## The vote shadow (`votesShadow`)

`votesShadow` in `RUST_API_ROUTES` selects no Rust route. `POST
/api/v3/votes` is still answered by Node, exactly as without it, with one
added request header, `X-Request-Id: $request_id`. nginx's `mirror` also sends
a copy of the request to `polis-api-shadow:5101`, the polis-api image in its
shadow role (`queue-rs/polis-api/README.md`, "Vote writer: the shadow role
and observe mode"). The shadow answers each copy 204 and writes nothing.

- **What is copied.** Only a POST to the exact path with a Content-Length from
  1 to 9999, the requests the live vote write location would send to
  polis-api. GET, HEAD, PUT and other methods, an empty or larger body, a
  chunked body, a trailing slash and other spellings of the path go to Node
  with no copy. The copy's path carries no query string.
- **Where it goes.** The target is a literal in
  `rust-api/shadow-mirror.conf.template`; no setting reaches it. The copy's
  location is `internal` (a direct request gets 404) and has no `error_page`,
  no retry and no route to Node, so a copy can never reach Node.
- **What it costs a participant.** Node's answer is never held behind the
  copy. What waits is the next request on the same client connection, until
  the copy ends: about a millisecond when the shadow answers or is down,
  refused, absent or closing, and at most the copy's timeouts (20 ms connect,
  20 ms send, 30 ms read, 30 ms resolve) when it is slow or silent. The body
  is read before Node is contacted (`mirror_request_body`); votes are small.
- **What it logs.** Two JSON lines per shadowed vote, both with
  `listener: "shadow"` and nginx's `request_id`, beside the access line:
  `shadow_edge` (Node's status and time as nginx saw them, the participant's
  total time) and `shadow_mirror` (the copy's status and time). A copy skipped
  by the body bound logs `mirror_status` 204 with an empty
  `mirror_upstream_status`. Neither line carries an address, a header value or
  a body.
- **The access line of a shadowed vote records no address.** It is written in
  `polis_shadow_access`: the image's `main` format with its two address
  fields written `-`, the first (`$remote_addr`, the peer) and the last
  (`X-Forwarded-For`; `"-"` is what `main` writes for a request without that
  header). Both fields keep their place. A participant's address is in one of
  the two: in `X-Forwarded-For` behind a load balancer, in the peer address
  where nginx faces participants directly. `shadow_edge`, written beside the
  access line, carries the request id that joins Node's and the shadow's
  lines; with an address on the access line, one vote's lines would tie an
  address to them. Every other request, the other methods on the same path
  included, keeps `main`. Node and the shadow receive `X-Forwarded-For`
  exactly as before. Anything that counts votes or voters from an address on
  nginx's access lines reads `-` for a shadowed vote. Not changed: the
  request line, the `Referer` and the user agent on that line; and nginx's
  error log, where a line written when the copy or Node fails names the peer
  as `client:` (it carries no request id).
- **With `votesRead`.** The vote read route's own location answers the path,
  with the POST diversion inserted first (POST goes to the shadow's named
  location; every other request keeps the read route's handling).
- **Refused.** `votesShadow` with `postVotes` (the shadow observes the votes
  Node answers): the renderer refuses the selection and every route stays on
  Node, and the web deploy and its validation refuse it before anything
  changes.
- **The service.** The web deploy starts `polis-api-shadow` only when
  `votesShadow` is selected (it is in the `rust-api` profile, so every deploy's
  teardown removes it), and validation then requires its `/health`:
  `role: "shadow"`, `postVotes.mode: "observe"`, `postVotes.enabled: false`,
  its two read-only pools, `shadow.listening`, a rate cap of at most 25 per
  second, and the release's version and commit. `scripts/rust-api-switch.sh`
  neither starts nor stops it: select or remove `votesShadow` through a deploy.
- **Rollback.** Remove `votesShadow` from `RUST_API_ROUTES` and deploy. nginx
  renders no shadow location, the teardown removes the container, and nothing
  was written.

Checks: the vote shadow sections of `queue-rs/polis-api/conformance/nginx-routing.sh`
(the rendered locations, the four timeouts line by line, the literal target,
no route from the copy to Node, the refusal), and
`queue-rs/polis-api/conformance/nginx-shadow.sh`, which runs the production
nginx image against a recording Node stand-in and a shadow stand-in that
answers, refuses, is absent from DNS, closes at once, stays silent, or answers
after 40 ms or 5 s (`--load` adds 16 keepalive connections of votes with a
silent shadow, against a control). `make check-nginx-upstreams` renders the
shadow selection and requires its target to be a service the web deploy
starts.
