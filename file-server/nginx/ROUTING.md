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

## The access line

nginx writes one access line for every request, in the format `polis_access`
(`nginx-ssl.site.default.conf`). It is the image's `main` format, field for
field, with two fields cut down:

- **The request line has no query string.** The method, the path as the
  client sent it up to the first `?`, and the protocol. A request line nginx
  could not read (answered 400), or refused for its length (414), is written
  `- - -`, never as it arrived.
- **The Referer has no query string and no fragment.** Scheme, host, port
  and path, up to the first `?` or `#`. No Referer is `-`. A Referer that is
  not an `http`, `https` or `android-app` address, or that holds a user name,
  a password, a space, a double quote, a backslash, a control character or a
  byte outside ASCII, is written `unparsed`, never as it arrived. A single
  quote in the path is kept, as browsers send it unencoded.

Why: this line carries the address a request came from (the peer, and the
`X-Forwarded-For` chain a load balancer adds to). A query string and a
Referer can carry what an embedding site supplies about a person (`xid`,
`x_name`, `x_profile_image_url`), the embedding page's address, and a
participant number from an older client. Written together, one line tied
them to an address.

Kept: both address fields, the status, the bytes, the user agent, and the
path of the Referer, so the conversation page a request was made from is
still on the line. Lost with the query string: anything a reader took from
it, a request's `lang` and `conversation_id` among them.

Not changed: what Node, polis-api and the shadow service receive (the whole
request, query string and Referer included), and nginx's error log, whose
lines print the whole request line and Referer of a request that failed at
an upstream.

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
  with no copy. The copy's path is the literal path and the request's query
  string, byte for byte as nginx received it, because that is the request a
  write route is handed. Node's `POST /api/v3/votes` reads its parameters
  from the body alone and ignores a query string. The vote handler does not
  take a request that has one, so the shadow reports such a copy as handed
  back for that reason (`shape_query`); a copy without the query string
  would be observed as a request the handler is never given. No line nginx
  writes for the request carries the query string: neither JSON line, nor
  the access line.
- **Only what is copied passes through the mirror.** One map
  (`$polis_shadow_copyable`, `rust-api/shadow-http.conf.template`) says
  which requests those are, and the path's location hands a request to the
  shadow's mirroring location on that map alone. Every other request to the
  path, a POST with an empty, undeclared, chunked or larger body included,
  is proxied to Node exactly as with nothing selected: its body streamed
  (never read whole first because of the mirror), no `X-Request-Id` added,
  the ordinary access line, no `shadow_edge` or `shadow_mirror` line. The
  bound is 9999 bytes because that is what the copy's location sends; the
  shadow service reads up to 65536, and nginx holds a body of up to 9999
  bytes in memory, so the mirror writes no temporary file.
- **Where it goes.** The target is a literal in
  `rust-api/shadow-mirror.conf.template`; no setting reaches it. The copy's
  location is `internal` (a direct request gets 404) and has no `error_page`,
  no retry and no route to Node, so a copy can never reach Node.
- **What it costs a participant.** Node's answer is never held behind the
  copy. What waits is the next request on the same client connection, until
  the copy ends: about a millisecond when the shadow answers or is down,
  refused, absent or closing, and at most the copy's timeouts (20 ms connect,
  20 ms send, 30 ms read, 30 ms resolve) when it is slow or silent. The body
  of a copied vote is read before Node is contacted (`mirror_request_body`),
  in memory; it is at most 9999 bytes.
- **What it logs.** Two JSON lines per shadowed vote, both with
  `listener: "shadow"` and nginx's `request_id`, beside the access line:
  `shadow_edge` (Node's status and time as nginx saw them, the participant's
  total time) and `shadow_mirror` (the copy's status and time). A POST that
  is not copied writes neither line. Neither line carries an address, a
  header value or a body.
- **The access line of a shadowed vote records no address.** It is written in
  `polis_shadow_access`: the ordinary format (above) with its two address
  fields written `-`, the first (`$remote_addr`, the peer) and the last
  (`X-Forwarded-For`; `"-"` is what the ordinary format writes for a request
  without that header). Both fields keep their place. A participant's address is in one of
  the two: in `X-Forwarded-For` behind a load balancer, in the peer address
  where nginx faces participants directly. `shadow_edge`, written beside the
  access line, carries the request id that joins Node's and the shadow's
  lines; with an address on the access line, one vote's lines would tie an
  address to them. Every other request, the other methods and the POSTs that
  are not copied on the same path included, keeps the ordinary format with
  its addresses: it has no shadow line and no request id. Node and the shadow receive `X-Forwarded-For`
  exactly as before. Anything that counts votes or voters from an address on
  nginx's access lines reads `-` for a shadowed vote. As on every access
  line, the request line is written without its query string and the
  `Referer` without its query string and fragment. Not changed: nginx's
  error log, where a line written when the copy or Node fails names the peer
  as `client:` and prints the whole request line and `Referer` (it carries
  no request id).
- **With `votesRead`.** The vote read route's own location answers the path,
  with the diversion inserted first (a POST that is copied goes to the
  shadow's named location; every other request keeps the read route's
  handling).
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

## The comment shadow (`commentsShadow`)

`commentsShadow` in `RUST_API_ROUTES` does for `POST /api/v3/comments` what
`votesShadow` does for votes, from the same three templates with the name and
the path replaced: Node answers every comment exactly as without it, with the
one added request header, and nginx's `mirror` sends a copy to the same
service, `polis-api-shadow:5101`, whose comment observer says what the Rust
comment handler would have done and writes nothing
(`docs/post-comments-rust-handler.md`, "Observe mode"). Both shadows are
normally selected together. Everything in the vote shadow's section holds for
the comment shadow; what follows is what differs or is worth saying again.

- **What is copied.** A POST to the exact path with a Content-Length from 1
  to 9999. That holds every comment Node accepts without external-identity
  fields: a text is at most 997 UTF-16 units, at most 5,982 bytes however
  JSON escapes it. The seed upload and the translation read, which have paths
  of their own under the comment path, are not touched. As for votes, the
  copy carries the request's query string. Node's `POST /api/v3/comments`
  reads its parameters from the body alone: a query string changes nothing
  in its answer, and a comment whose `conversation_id` is only there is
  refused with 400. The comment handler does not take a request that has a
  query string, so such a copy is observed as handed back for that reason
  (`shape_query`). The clients in this repository send a comment's
  parameters in the body and no query string.
- **The copies have a rate.** At most 2 a second on one box, and 4 more at
  once (`limit_req`, one zone, `rust-api/shadow-rate.conf.template`). A copy
  over the rate ends in the copy's own location with 429 before any
  connection is opened; its `shadow_mirror` line reads `"mirror_status":429`
  with an empty `mirror_upstream_status`, and nothing is written to the error
  log. The zone is used in the copy's location only. The request Node answers
  is never counted, delayed or refused: a run of comments faster than the
  rate is answered by Node, every one. Vote copies have no nginx rate. On a
  client connection that is reused (a load balancer's), nginx's mirror keeps
  a request open until its copy has ended, so the next request on that
  connection waits for a copy that was sent, for at most the copy's
  timeouts; a copy over the rate ends before any connection is opened and
  the next request does not wait for it at all.
- **What it does to a comment POST.** Only a POST that is copied (a declared
  body of 1 to 9999 bytes) passes through the mirror. With
  `mirror_request_body`, nginx reads the whole body of such a request, in
  memory, before it contacts Node; without the shadow it starts sending to
  Node as soon as it has the request's headers. For a comment that arrives
  whole (every real one: a few hundred bytes to a few kilobytes) Node has the
  request no later than before. A copied body that arrives slowly reaches
  Node when its last byte has arrived, which is when Node could start work on
  it either way. Any other POST (a larger body; an empty, chunked or undeclared one) is
  proxied as with nothing selected, streamed and never held for the mirror,
  and is not observed. A comment Node accepts is larger than the bound only
  when its text and its `xid` are both long and written as `\u` escapes (six
  bytes for each of up to 997 and 999 UTF-16 units: about 12,150 bytes at
  most); without an `xid` it is at most about 6,150 bytes.
- **Reading comments is untouched.** GET and HEAD on the path, which every
  client polls, are answered and logged exactly as before: by Node through
  the path's location, or by polis-api when `comments` is selected too, in
  which case the read route's own location carries the POST diversion first.
- **The access line of a shadowed comment records no address**, in the same
  format as a shadowed vote's, and the two JSON lines are the vote shadow's
  formats: a copied comment's lines carry what a copied vote's carry.
- **When the copy fails.** A shadow service that is down, absent, paused,
  slow, answering 404 (its comment observer is not switched on) or answering
  500 changes nothing in Node's answer, its status, headers or bytes. What
  waits is the next request on the same client connection, for at most the
  copy's timeouts.
- **Refused.** `commentsShadow` together with a route that writes comments.
  No such selector exists yet; the name reserved for it, `postComments`, is
  refused beside `commentsShadow` by the web deploy and its validation
  already, and the renderer refuses it as an unknown name.
- **The service.** The web deploy starts `polis-api-shadow` when either
  shadow is selected. The comment observer's switch is not in the env
  document and not in `docker-compose.yml`, where it is empty: the deploy
  derives it from the route list and writes it into the Compose override it
  generates, `observe` exactly when `commentsShadow` is named, and checks the
  composed value before it replaces anything. With either shadow selected it
  also reads back, from the same composed configuration and before anything
  is replaced, the settings that make the service the shadow service: the
  shadow role, its listener, the vote observer's switch and the two blank
  signing-key settings. A composition that lost them is refused by name
  (never by value) while the box's running containers are untouched.
  Validation then requires the
  service's `/health` to match: with `commentsShadow`, `postComments` in
  observe mode, never enabled, its two read-only pools and no other, room for
  8 observations and 64 waiting read-backs, a cap of at most 6 a second;
  without it, no `postComments` at all. The observer adds three read-only
  connections to the primary per box (seven for the service with both
  observers, four with the vote observer alone).
- **Order.** Deploy a release that knows `commentsShadow` before the name is
  put in `RUST_API_ROUTES`. A release whose renderer does not know the name
  refuses the whole list and sends every route to Node, the routes polis-api
  serves and the vote shadow's copies included, while that release's own
  validation still passes. For the same reason remove the name before
  deploying an older release. "Deployed" means on every web box: where boxes
  are added automatically, a new box runs the deployment group's last
  successful revision with `RUST_API_ROUTES` as it is at that moment, so the
  name must not be there before that revision knows it.
- **Rollback.** Remove `commentsShadow` from `RUST_API_ROUTES` and deploy.
  nginx renders no comment shadow location, the shadow service starts without
  the comment observer (or not at all, when `votesShadow` is not selected
  either), and nothing was written.

Checks: the comment shadow sections of
`queue-rs/polis-api/conformance/nginx-routing.sh` (each rendered location is
the vote shadow's with the name and path replaced, plus the rate; both
shadows together; with the comment reads; the refusals);
`queue-rs/polis-api/conformance/nginx-shadow.sh`, which runs the comment
shadow through every mode of the shadow stand-in and two more (404 and 500),
both shadows together, the reads, the rate, and bodies from 180 bytes to the
largest nginx and Node accept (`--measure` prints what the mirror costs a
comment); and `queue-rs/polis-api/conformance/shadow-stack.sh`, which runs
real comments through nginx to the real Node server with the real shadow
service under `docker-compose.yml`, started without the switch, with it,
paused and stopped, and compares Node's replies byte for byte.

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
