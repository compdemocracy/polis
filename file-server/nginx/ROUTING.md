# Paths accepted by the edge proxy

Order matters: exact document locations, existing Rust route selections,
application locations, static locations, then the local 404. The alpha
prefixes retain their existing upstream and rewrite. Rust switches retain
their method/body gates, timeouts and per-route fallback behavior. With an
empty `RUST_API_ROUTES`, all application entries below use Node.

“File-server” means the same final destination as before, with the application
proxy hop removed. It still owns file bytes, header sidecars, ranges and
conditional responses. This change does not retire registered pages or APIs.
Paths proposed for retirement are listed here too because those registrations
still exist in this source tree.

| Path family | Destination after this change |
|---|---|
| `/alpha/*` (including `/alpha/embed.js`) | Alpha on port 4321; remove `/alpha` before forwarding |
| `/_astro/*` | Alpha on port 4321; preserve the path |
| `/api/*` (case insensitive) | Node, except the paths and methods explicitly selected by existing Rust switches |
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
| `/static/*` | File-server; admin bundles, maps and versioned font CSS/font files |
| `/js/*`, `/css/*`, `/assets/*`, `/images/*`, `/fonts/*` | File-server; participation bundles/styles, JWT library, images and Font Awesome |
| `/twemoji/*` | File-server; versioned emoji images |
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

A known static prefix can still return a file-server 404 for a missing file.
Unknown paths outside those prefixes use the edge's local 404. API-prefix
misses still reach the application, as do broad registered page prefixes;
this preserves application routing until those routes are retired. Unknown
paths ending in a slash now return 404 instead of Node's catch-all redirect.
No database work, queueing, locks or admission checks are added to voting,
comment submission or next-statement requests.
