use clap::{Arg, ArgAction, Command};
use serde_json::{json, Value};

// One declaration drives parser, nested help, full command tree, and JSON schema.
const GROUPS: &[(&str, &str, &str)] = &[
 ("auth", "Sign in and inspect your session", "login status logout token refresh"),
 ("account", "Your identity and organization", "view edit invite verify"),
 ("conversation", "Create and explore conversations", "create reserve list view edit close reopen stats activity snapshot uuid email-link share"),
 ("seed", "Prepare and import seed statements", "add import csv/validate csv/preview csv/normalize"),
 ("statement", "Read and contribute participant statements", "list view add next translations flag upvote star trash"),
 ("vote", "Participate with agree, disagree, or pass", "cast list import csv/validate csv/convert"),
 ("moderate", "Review statements as a moderator", "list accept reject set"),
 ("participant", "Participation, groups, and access lists", "join login status list export activity preferences group group-members query locations highlight/list highlight/set xid/list xid/export allowlist/view allowlist/import allowlist/export"),
 ("invite", "Invite people and manage invitation waves", "moderator/list moderator/create email/create email/view wave/list wave/create list export status accept"),
 ("metadata", "Conversation questions and choices", "view choices question/list question/add question/delete answer/list answer/add answer/delete"),
 ("context", "Browse and create conversation contexts", "list create"),
 ("notification", "Manage conversation subscriptions", "subscribe unsubscribe set"),
 ("report", "Publish and explore reports", "list create view edit statements/list statements/select stats topics visualization export feed/list feed/consensus feed/topics"),
 ("math", "Inspect the conversation's mathematical summary", "view correlation refresh"),
 ("topic", "Explore topic structure and statements", "list statements hierarchy proximity stats moderate"),
 ("agenda", "Choose and manage topic priorities", "priorities list add replace remove"),
 ("delphi", "Run analysis and read stored results", "run status results logs wait narrative/run narrative/view narrative/export narrative/import statement/export statement/import visualization/view"),
 ("collective", "Generate and read collective statements", "generate list view export import"),
 ("plan", "Account plan, usage, and billing", "view usage upgrade manage"),
 ("queue", "Inspect operator queue state", "status list view"),
 ("ops", "Discover authorized operations panels", "status pages page conversations/list"),
 ("node", "Prepare and operate your local Polis node", "init doctor prepare up status logs down backup restore upgrade"),
 ("agent", "An automation guide to Polis", "guide"),
 ("mcp", "Connect a desktop agent over stdio", "serve"),
 ("support", "Contact the project and contribute", "contact contribute"),
];
fn arg(name: &str, help: &str) -> Arg {
    Arg::new(name.to_owned())
        .long(name.to_owned())
        .help(help.to_owned())
        .value_name(name.to_uppercase())
}
fn pos(name: &str, required: bool) -> Arg {
    Arg::new(name.to_owned()).required(required)
}
fn flag(name: &str, help: &str) -> Arg {
    arg(name, help).action(ArgAction::SetTrue)
}
pub fn available(path: &str) -> bool {
    matches!(
        path,
        "conversation reserve"
            | "participant preferences"
            | "participant locations"
            | "participant highlight list"
            | "participant group-members"
            | "math view"
            | "metadata answer add"
            | "metadata question delete"
            | "metadata answer delete"
            | "metadata question add"
            | "context create"
            | "delphi statement export"
            | "delphi statement import"
            | "metadata question list"
            | "metadata answer list"
            | "context list"
            | "statement list"
            | "statement view"
            | "collective list"
            | "collective view"
            | "topic list"
            | "topic statements"
            | "topic hierarchy"
            | "topic proximity"
            | "topic stats"
            | "report topics"
            | "report stats"
            | "report statements list"
            | "account view"
            | "conversation edit"
            | "conversation share"
            | "conversation stats"
            | "report create"
            | "auth login"
            | "auth status"
            | "auth logout"
            | "auth token"
            | "conversation create"
            | "conversation list"
            | "conversation view"
            | "conversation close"
            | "conversation reopen"
            | "seed add"
            | "seed import"
            | "seed csv validate"
            | "seed csv preview"
            | "moderate list"
            | "moderate accept"
            | "moderate reject"
            | "participant list"
            | "participant status"
            | "participant xid list"
            | "participant export"
            | "participant xid export"
            | "vote list"
            | "report list"
            | "report view"
            | "report export"
            | "delphi status"
            | "delphi results"
            | "delphi narrative view"
            | "collective export"
            | "collective import"
            | "delphi narrative export"
            | "delphi narrative import"
            | "delphi visualization view"
            | "plan view"
            | "plan upgrade"
            | "plan manage"
            | "completion"
            | "tutorial"
            | "api"
            | "schema"
            | "help"
            | "agent guide"
    )
}
fn leaf(path: &str) -> Command {
    let name = path.split(' ').next_back().unwrap();
    let about = match path {
        "conversation reserve" => "Allocate a conversation ID without creating a conversation",
        "participant preferences" => "Set this account's translation-display preference",
        "participant locations" => "Read stored coordinates for an opinion-group array index",
        "participant highlight list" => {
            "Read visible participant profiles with an optional exact moderation filter"
        }
        "participant group-members" => "Read the public base-cluster index to participant-ID map",
        "math view" => "Read the public served PCA presentation; never starts computation",
        "metadata question delete" => {
            "Soft-delete an owner-selected question and its answer options"
        }
        "metadata answer add" => "Create or reactivate an answer option under an active question",
        "metadata answer delete" => "Soft-delete one owner-selected answer option",
        "metadata question add" => "Create a metadata question as the conversation owner",
        "context create" => "Create a public context on this site as a signed-in account",
        "metadata question list" => "Read active conversation metadata questions",
        "metadata answer list" => "Read active metadata answer options, not participant responses",
        "context list" => "List public conversation contexts from the selected site",
        "statement list" => "Page through participant-visible statements in a conversation",
        "statement view" => {
            "Read one participant-visible statement by its conversation-local number"
        }
        "collective list" => {
            "Read stored collective statements, deduplicated by the server by topic"
        }
        "collective view" => "Read one stored collective statement by its exact opaque ID",
        "topic list" | "report topics" => {
            "Read stored topics, retaining unavailable moderation markers"
        }
        "topic statements" => "Read statements by exact topic key; missing stores are errors",
        "topic hierarchy" => "Read the stored topic hierarchy; no analysis starts",
        "topic proximity" => "Read stored topic coordinates for a layer or all layers",
        "topic stats" => "Read topic moderation counts and their availability",
        "report stats" => "Read participation timing through a matching report capability",
        "report statements list" => "Page through visible statements with report-selection fields",
        "account view" => "Read the signed-in account from this site's users API",
        "conversation edit" => {
            "Edit moderator settings, preserve legacy defaults, then verify them"
        }
        "conversation share" => "Format participation and admin share links locally; sends nothing",
        "conversation stats" => {
            "Read moderator-authorized participation statistics, bounded to 8 MiB"
        }
        "report create" => "Create report configuration as moderator; no analysis is started",
        "auth login" => "Sign in in your browser with PKCE; save the sign-in in the macOS Keychain",
        "auth token" => "Print the access token (secret) for the selected site; refresh if needed",
        "auth status" => "Check the saved sign-in with the server",
        "auth logout" => "Remove the saved sign-in and suppress stale Keychain credentials",
        "conversation create" => "Create a conversation owned by the authenticated account",
        "conversation list" => "List only your conversations, newest created first",
        "conversation view" => "Read one conversation by its public ID",
        "conversation close" => "Close participation as owner; confirm the stored state",
        "conversation reopen" => "Reopen participation as owner; confirm the stored state",
        "participant export" | "participant xid export" => {
            "Export moderator-authorized participant XIDs (not a complete roster)"
        }
        "plan upgrade" | "plan manage" => {
            "Open the site account page; billing checkout is not available"
        }
        "completion" => "Generate shell completions from the command tree without accessing a site",
        "tutorial" => "Read the terminal getting-started manual",
        "seed add" => "Add one seed statement through the moderator-enforced bulk API",
        "seed import" => "Validate a CSV, then import its seed statements as moderator",
        "seed csv validate" => "Validate UTF-8 CSV headers, lengths, duplicates, and row counts",
        "seed csv preview" => "Show the exact validated statements without submitting them",
        "moderate list" => "Read the moderation queue with limit and offset",
        "moderate accept" => "Accept one statement, preserving its current metadata",
        "moderate reject" => "Reject one statement, preserving its current metadata",
        "participant list" => {
            "Read this account's participation record as a scoped list (not a roster)"
        }
        "participant status" => "Read this account's participation record, or null if not joined",
        "participant xid list" => "Read the site's moderator-authorized participant XID mapping",
        "vote list" => polis_contracts::votes::WIRE_HELP,
        "report list" => "List a conversation's reports as moderator",
        "report view" => "Read stored report configuration by report ID",
        "report export" => "Download an existing report CSV or format sidecar to a new local file",
        "delphi status" => {
            "Read stored job metadata; preserve workLive and supersession without submitting work"
        }
        "delphi results" | "delphi narrative view" => {
            "Read stored narrative results; never generate or refresh"
        }
        "collective export" | "delphi statement export" => {
            "Export topic consensus inputs and a result schema as owner; no model call"
        }
        "collective import" | "delphi statement import" => {
            "Import a cited candidate collective statement with agent provenance as owner"
        }
        "delphi narrative export" => {
            "Export exact batch narrative prompts and a result schema as owner; no model call"
        }
        "delphi narrative import" => {
            "Publish validated external-agent narratives as owner; no model call"
        }
        "delphi visualization view" => {
            "Read stored visualization metadata; no URL download or generation"
        }
        "plan view" => "Verify the account and report plan/usage as unavailable on the current API",
        "agent guide" => "Print the first-pass automation contract",
        _ => "Planned — discover this operation with --help",
    };
    let detail = if available(path) {
        format!("{about}.\n\nAuthentication and resource permissions are enforced by the selected site. No automatic retries. Usage and quota are unavailable until the site supplies an authoritative contract.")
    } else {
        format!("Planned command: polis {path}.\n\nThis will {}. It is not implemented in this release. Running it returns capability_unavailable (exit 8) without making a request.\n\nBilling, device authorization, node packaging, and operator APIs require additional site capabilities. No paid work or browser action is triggered.", purpose(path))
    };
    let mut c = Command::new(name.to_owned())
        .about(about)
        .long_about(detail);
    c=match path {
 "conversation reserve" => c.after_help("EXAMPLE\n  polis conversation reserve --json\n\nOne authenticated POST requests a new ID. Legacy compatibility requires a conversation row at zid=0; a fresh database lacks it and returns a server failure. The CLI does not create that row. The legacy server registers it with zid=0: no conversation is created and no owner is bound. The ID is not proof of ownership or exclusive access. Preserve the receipt for a later explicit API creation request; conversation create does not yet accept a reserved ID. No lookup, release, expiry or idempotency contract is exposed. Every invocation can allocate another ID; no automatic retry or readback. If the response is lost, ask the site operator to inspect reservations before retrying. Responses are bounded to 8 MiB and --timeout."),
 "participant preferences" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("translations","Store translation display preference for the signed-in account").required(true).value_parser(["true","false"])).after_help("EXAMPLES\n  polis participant preferences --conversation CONV --translations true --json\n  polis participant preferences --conversation CONV --translations false --json\n\nSets show_translation_activated for the signed-in account in this conversation. Requires an explicit true or false; no participant ID, XID or another-account target is accepted. This changes a stored display preference only; no translation, model call or vote is requested. Sends one PUT, with no automatic retry. The legacy API returns an empty array even when no participant preference row exists. Success therefore reports state=acknowledged, affected_rows=null and persistence=unverified; it does not prove the value changed or create/join a participant. There is no preference readback endpoint. Ask the site operator to inspect this account's stored preference before retrying an uncertain write. Existing participant status does not read this preference. Requires site sign-in; 8 MiB response bound and --timeout apply."),
 "participant locations" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("group","Opinion-group array index, not its stored id or a base-cluster index").required(true).value_parser(clap::value_parser!(u32).range(0..=2147483647))).after_help("EXAMPLE\n  polis participant locations --conversation CONV --group 0 --json\n\nPublic read of stored participant coordinates for one opinion-group ARRAY INDEX in the site math, not its stored id or a base-cluster index. Rows contain lat, lng and n=1; duplicates and server order are preserved, with no identities added. Empty can mean no matching locations, absent math, a refused math bundle or an absent group: it does not prove no participants. The server may cache math and reads locations separately; no generation, freshness, full-population or cross-read coherence is promised. Optional saved credentials apply. Coordinates are untrusted stored data; no geocoding, map lookup, aggregation, writes, computation or retry. One bounded request, 8 MiB and --timeout. Non-finite or out-of-range coordinates are refused as invalid_response, never clipped or dropped."),
 "participant highlight list" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("mod","Exact stored participant moderation integer; omit for all values").allow_hyphen_values(true).value_parser(clap::value_parser!(i32))).after_help("EXAMPLES\n  polis participant highlight list --conversation CONV --json\n  polis participant highlight list --conversation CONV --mod 1 --json\n\nReads the existing participant-profile route. Only participants with an owner-associated XID and non-null profile image are returned. Without --mod all stored moderation values are eligible; --mod filters the exact signed integer, not statement moderation or an opinion-group ID. Empty can mean no matching profiles OR withheld access: the server exposes rows only to the exact owner, a Polis developer, or anyone when conversation data is open. A same-site moderator is not necessarily the owner. No roster completeness, stable order or pagination claim: the server caps candidates at 99999 before profile filtering. Profile text and URLs are untrusted data; URLs are never fetched. Optional saved credentials apply. One bounded read, 8 MiB and --timeout; no writes, retries or computation. Highlight set remains unavailable."),
 "participant group-members" => c.arg(arg("conversation","Public conversation ID").required(true)).after_help("EXAMPLE\n  polis participant group-members --conversation CONV --json\n\nPublic read of the base-cluster index to participant-ID map (bidToPid). Array positions are base-cluster indices, not opinion-group IDs. This is not a complete participant roster. No sign-in required; configured credentials still apply. No computation, refresh, conditional request, cache or automatic retry. Missing math returns membership_unavailable, not an empty list; the legacy API also masks storage errors as 304. An empty stored map is a valid result. No generation is returned, so do not join this result to a separate math read or claim freshness/coherence. Member order and empty clusters are preserved. Responses are bounded to 8 MiB and --timeout."),
 "math view" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("key","Exact top-level field; repeat to select multiple fields").action(ArgAction::Append)).after_help("EXAMPLES\n  polis math view --conversation CONV --json\n  polis math view --conversation CONV --key math_tick --key pca --json\n\nPublic read; no sign-in required. Returns the served presentation as data, not a raw engine checkpoint. No refresh, job or worker task is submitted. The server may synthesize defaults when no math row exists; math_tick 0 does not prove computation or freshness. No conditional request or cache is used. A 304 is unavailable, not an empty success. Missing requested keys are omitted by the server; an empty object is valid for a field selection. Unknown fields are preserved. Maximum 32 unique keys, each 1–100 ASCII letters/digits/_/-, no commas. Whole gzip and selected JSON responses are bounded to 8 MiB compressed and decoded; waits obey --timeout. JSON is parsed, not a byte-exact archive; inherited float roundoff remains. No automatic retry."),
 "metadata answer add" => c.arg(arg("conversation","Public conversation ID containing the question").required(true)).arg(arg("question","Exact active pmqid from metadata question list").required(true).value_parser(clap::value_parser!(u32).range(1..=2147483647))).arg(arg("value","Exact option text: 1–999 UTF-16 code units; no surrounding ASCII spaces").required(true)).arg(flag("yes","Confirm creation or reactivation of this exact answer option")).after_help("EXAMPLE\n  polis metadata answer add --conversation CONV --question 7 --value 'Local resident' --yes --json\n\nRequires --yes and the exact conversation owner. Creates an answer option, not a participant response. The existing API may reactivate a deleted option with the same exact text and retain its ID; the receipt does not distinguish creation from reactivation. An already-active exact-text option is refused without POST. Checks active question membership and option lists before one POST. These client checks are not a server authorization boundary or compare-and-set; the legacy server does not independently bind question to conversation and concurrent deletion remains possible. Accepted receipts survive failed readback; inspect BOTH lists before retrying. No automatic retry, trimming, required/exclusive setting or participant-response change."),
 "metadata question delete" | "metadata answer delete" => {
  c=c.arg(arg("conversation","Public conversation ID containing the target").required(true))
   .arg(arg("question","Exact pmqid from metadata question list").required(true).value_parser(clap::value_parser!(u32).range(1..=2147483647)))
   .arg(flag("yes","Confirm soft deletion of this exact target; questions also delete all their answer options"));
  if path=="metadata answer delete" { c=c.arg(arg("answer","Exact pmaid from metadata answer list").required(true).value_parser(clap::value_parser!(u32).range(1..=2147483647))); }
  c.after_help("EXAMPLES\n  polis metadata question delete --conversation CONV --question 7 --yes --json\n  polis metadata answer delete --conversation CONV --question 7 --answer 9 --yes --json\n\nRequires --yes and the exact conversation owner. Checks active question/option membership before sending one DELETE; a missing or mismatched target sends no write. Answer options are not participant responses. Question deletion also soft-deletes every option under it; the legacy two-update cascade is non-atomic. No compare-and-set: concurrent changes can occur after preflight. An accepted success receipt is preserved if readback fails; absence in active lists is an observation, not proof of physical erasure or an audit of participant responses. Text can remain reserved after deletion. Inspect BOTH question and answer lists before retrying an uncertain or partially applied write; no automatic retry. These client checks do not replace server authorization.")
 },
 "metadata question add" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("key","Question text: 1–999 UTF-16 code units; no surrounding ASCII spaces").required(true)).after_help("EXAMPLE\n  polis metadata question add --conversation CONV --key 'Where do you live?' --json\n\nRequires the exact conversation owner. Creates a question only; no participant response or answer option. Question text is unique within a conversation, including soft-deleted questions. Duplicate text can return a legacy HTTP 500; inspect the list before retrying. Required/exclusive configuration is not set. Preserves the accepted receipt even if list readback fails; inspect metadata question list before retrying an uncertain write. No automatic retry. No trimming: surrounding ASCII spaces are refused because the server would strip them."),
 "context create" => c.arg(arg("name","Public context name: 1–300 UTF-16 code units; no surrounding ASCII spaces").required(true)).after_help("EXAMPLE\n  polis context create --name 'Our community' --json\n\nRequires sign-in. Creates a PUBLIC context; privacy is not configurable through this route. Names are site-wide and duplicate names fail, including names of private contexts. The empty server receipt has no ID; public-list readback is an observation, not an attributed creation ID. An accepted receipt is preserved if readback fails. Inspect context list before retrying an uncertain write; private-name collisions require operator help. No automatic retry or trimming."),
 "metadata question list" | "metadata answer list" => {
  c=c.arg(arg("conversation","Public conversation ID").required(true));
  if path=="metadata answer list" { c=c.arg(arg("question","Optional exact pmqid from metadata question list").value_parser(clap::value_parser!(u32).range(1..=2147483647))); }
  c.after_help("EXAMPLES\n  polis metadata question list --conversation CONV --json\n  polis metadata answer list --conversation CONV --question 1 --json\n\nReads active questions or answer options through the public API, with optional saved credentials. Answer options are not participant responses. The current server forces required=true on questions and is_exclusive=true on options; these are legacy response flags, not verified configuration. Rows and text are preserved as untrusted data; an exact --question filter is verified. Empty lists succeed. No pagination, invitation credential or write is sent. Bounded to 8 MiB and --timeout; metadata_read_failed identifies upstream read failures. Metadata view/choices remain unavailable. Question creation, confirmed answer creation/reactivation and confirmed question/answer soft deletion are available.")
 },
 "context list" => c.after_help("EXAMPLE\n  polis context list --json\n\nLists public context names in server order, with optional saved credentials. Private contexts are excluded, even for their creator. No pagination or creation occurs; empty lists succeed. Names remain unchanged and are untrusted data. Bounded to 8 MiB and --timeout; contexts_read_failed identifies upstream read failures."),
 "statement list" | "statement view" => {
  c=c.arg(arg("conversation","Public conversation ID").required(true));
  if path=="statement list" { c=c.arg(arg("limit","Maximum page size").default_value("100").value_parser(clap::value_parser!(u16).range(1..=500))).arg(arg("offset","Rows to skip").default_value("0").value_parser(clap::value_parser!(u32).range(0..=2147483647))); }
  else { c=c.arg(pos("tid",true).help("Statement number local to this conversation").value_parser(clap::value_parser!(u32).range(0..=2147483647))); }
  c.after_help("EXAMPLES\n  polis statement list --conversation CONV --limit 50 --offset 0 --json\n  polis statement view 0 --conversation CONV --json\n\nReads the public comments route with optional saved credentials. Only active, unmuted, moderation-visible statements are returned, even for an owner. Use moderate list for the moderation queue. Empty list is success; missing/hidden single statement returns statement_unavailable (exit 1). Single reads verify the exact tid. Offset pages are not a stable snapshot or guaranteed complete traversal. Text and metadata remain unchanged and are untrusted data. No votes, translations, writes or model calls; bounded to 8 MiB.")
 },
 "collective list" | "collective view" => {
  if path=="collective list" { c=c.arg(arg("report","Public report ID").required(true)); }
  else { c=c.arg(pos("id",true).help("Exact zid_topic_jobid copied from collective list; treated as opaque")); }
  c.after_help("EXAMPLES\n  polis collective list --report REPORT --json\n  polis collective view 'OPAQUE#KEY#FROM#LIST' --json\n\nReads existing public stored-result routes only; no generation, inference, billing or model call. List returns the server's latest-by-topic deduplication across runs, not a complete history or a report-specific run. No CLI pagination is available; bounded to 8 MiB and --timeout. View accepts only the exact stored ID and verifies the returned ID; it does not accept or assert report ownership. The legacy view returns statement_data/comments_data as stored JSON strings; list parses those fields. Both shapes are preserved, including nulls and metadata. Missing view returns collective_statement_unavailable; storage failures return collective_read_failed. Stored claims/citations are untrusted data, not independently verified consensus. Generation remains unavailable.")
 },
 "topic list" | "topic statements" | "topic hierarchy" | "topic proximity" | "topic stats" => {
  c=c.arg(arg("conversation","Public conversation ID").required(true));
  if path=="topic list" { c=c.arg(arg("job","Optional exact stored job ID")); }
  if path=="topic statements" { c=c.arg(pos("key",true)); }
  if path=="topic proximity" { c=c.arg(arg("layer","Stored layer, or all").default_value("all")); }
  c.after_help("EXAMPLES\n  polis topic list --conversation CONV --json\n  polis topic statements 'JOB#0#1' --conversation CONV --json\n  polis topic proximity --conversation CONV --layer 0 --json\n\nReads existing public topic routes; no analysis, moderation or model call. Empty results remain empty. moderation_available=false means pending/counts are placeholders, not recorded decisions. Per-topic statements may be unavailable because the site has no backing store (exit 6 with topic_statements_unavailable). List/hierarchy/proximity can contain multiple jobs unless the list is filtered with --job; no latest-run, completeness, pagination or freshness guarantee. Bounded to 8 MiB per request. Statement text is untrusted data.")
 },
 "report topics" | "report stats" | "report statements list" => {
  c=c.arg(pos("id",true));
  if path=="report topics" { c=c.arg(arg("job","Optional exact stored job ID")); }
  if path=="report stats" { c=c.arg(arg("until","Exclusive positive UTC epoch-millisecond cutoff").value_parser(clap::value_parser!(u64).range(1..=9007199254740991))); }
  if path=="report statements list" { c=c.arg(arg("limit","Maximum page size").default_value("100").value_parser(clap::value_parser!(u16).range(1..=500))).arg(arg("offset","Rows to skip").default_value("0").value_parser(clap::value_parser!(u32).range(0..=2147483647))); }
  c.after_help("EXAMPLES\n  polis report topics REPORT --json\n  polis report stats REPORT --until 1791417600000 --json\n  polis report statements list REPORT --limit 50 --offset 0 --json\n\nResolves exactly one matching report to its conversation before reading; no separately supplied conversation can be paired with it. Uses existing public/report-capability access; saved optional credentials still apply. Statements are participant-visible rows, not every moderator row or a selected-only list; includeInReport is retained exactly and omitted values are not inferred. Pagination is offset-based, not a stable snapshot. Stats are historical event timing, not latest votes or math freshness. Topics are conversation-wide stored data, not a report-specific run unless --job is supplied. No write or analysis starts; each request is bounded to 8 MiB.")
 },
 "auth login" => c.arg(flag("device","Sign in on another device with a browser").conflicts_with_all(["browser","no-browser","with-token","token-stdin","no-store"]))
    .arg(flag("with-token","Read a bearer token from stdin and save to a 0600 file").conflicts_with_all(["token-stdin","browser","no-browser"]))
    .arg(flag("browser","Start a fresh browser sign-in").conflicts_with("token-stdin"))
    .arg(flag("no-browser","Print the browser login URL for this machine").conflicts_with("token-stdin"))
    .arg(flag("token-stdin","Read an access token from stdin"))
    .arg(flag("no-store","Validate stdin token without storing it").requires("token-stdin"))
    .after_help("Browser login uses Authorization Code + S256 PKCE. --device signs in from a different browser without a callback listener. Both request offline_access. On macOS the access/refresh credentials are saved in the login Keychain; the fallback is an owner-only 0600 file under a 0700 directory, used when the Keychain is unavailable, with --no-interactive, with --with-token and on other platforms. Refresh is silent before expiry; revoked refresh credentials require a new sign-in. --no-interactive never shows browser or Keychain dialogs and still reads a Keychain sign-in when no dialog is needed; device authorization still needs approval on another device. auth token explicitly prints a secret. auth logout clears local credentials, not the provider browser session or server grant. POLIS_TOKEN overrides stored credentials (POLIS_TOKEN_<PROFILE> for developer profiles)."),
 "conversation edit" => c.arg(pos("id",true)).arg(arg("topic","New topic, 1–1000 UTF-16 units; exact text preserved")).arg(arg("description","New description, up to 50000 UTF-16 units; empty string clears it")).arg(arg("draft","Draft state; explicit true or false").value_parser(["true","false"])).arg(arg("data-open","Public data setting; explicit true or false").value_parser(["true","false"])).arg(arg("strict-moderation","Require moderation; explicit true or false").value_parser(["true","false"])).after_help("EXAMPLES\n  polis conversation edit CONV --topic 'Our shared priorities'\n  polis conversation edit CONV --description '' --draft true --json\n\nRequires moderator access. Reads current settings to preserve the five flags that the legacy PUT defaults to false. Refuses incomplete settings before writing. No compare-and-set: coordinate concurrent moderator edits. Verifies requested and preserved flags; failed readback exits 7. No email, ID rotation or automatic retry."),
 "conversation share" => c.arg(pos("id",true)).after_help("EXAMPLE\n  polis conversation share CONV --json\n\nReturns participation_url and admin_share_url for the configured site. Links are unverified: this performs no HTTP request and changes no access. It never emails, opens a browser, creates an invitation or discloses a saved token."),
 "conversation stats" => c.arg(pos("id",true)).arg(arg("until","Exclusive UTC epoch-millisecond cutoff, positive safe integer").value_parser(clap::value_parser!(u64).range(1..=9007199254740991))).after_help("EXAMPLES\n  polis conversation stats CONV --json\n  polis conversation stats CONV --until 1791417600000 --json\n\nRequires this site's moderator permission. Returns the existing vote/comment timing and histogram fields unchanged; these are historical event statistics, not unique latest votes or math freshness. No pagination; bounded to 8 MiB and the request timeout. No report-ID permission fallback."),
 "report create" => c.arg(arg("conversation","Public conversation ID").required(true)).after_help("EXAMPLE\n  polis report create --conversation CONV --json\n  polis report list --conversation CONV --json\n\nRequires moderator access. Creates report configuration with the existing default mod_level=-2; starts no math, export or Delphi generation. The legacy POST has no created ID or idempotency key. data.report_id stays null; data.reports is an uncorrelated readback list, never proof of which report was created. A failed readback preserves the accepted receipt. Never repeat creation to recover a lost ID; list first. An uncertain write exits 7."),
 "account view" => c.after_help("EXAMPLE\n  polis account view --json\n\nRequires authentication. Returns this account's server profile, which may include personal data. It is not a plan, credit balance, or proof of permission for another resource."),
 "conversation create" => c.arg(arg("topic","Conversation topic (1–1000 UTF-16 units)").required(true)).arg(arg("description","Optional description (up to 50000 UTF-16 units)")).arg(flag("draft","Create a draft")),
 "conversation list" => c.arg(flag("mine","Owned conversations only (the default)")).arg(flag("recent","Newest created first (the default)")).arg(arg("limit","Rows read from the site before the owner filter (1–9999)").default_value("100").value_parser(clap::value_parser!(u16).range(1..=9999))).arg(arg("active","Filter active or closed").value_parser(["true","false"])).arg(arg("draft","Filter draft or published").value_parser(["true","false"])).arg(arg("search","Case-insensitive topic substring (literal), applied to the rows read")).after_help("EXAMPLES\n  polis conversation list --json\n  polis conversation list --limit 500 --active true --json\n  polis conversation list --search 'budget' --json\n\nReads GET /api/v3/conversations. The current API returns an array of the conversations this account owns or shares a site with, newest created first, at most --limit rows; it has no offset, cursor, owner filter or search parameter. Rows whose server-set is_owner is false are dropped here, so pagination.returned can be below pagination.server_rows. pagination.truncated is true when the site returned --limit rows: raise --limit to read more. --active and --draft are applied by the site; --search is a literal, case-insensitive topic match applied to the rows read. Requires sign-in. One bounded read, 8 MiB and --timeout; no automatic retry."),
 "conversation view" | "conversation close" | "conversation reopen" => c.arg(pos("id",true)),
 "participant export"|"participant xid export" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("output","New output file; never overwrite").required(true)).arg(arg("format","CSV preserves bytes; JSON retains every CSV cell as a string").value_parser(["csv","json"]).default_value("csv")).after_help("Uses the moderator-enforced XID export. Only participants with XIDs are included, not every participant. Server caps this endpoint at 1,000,000 rows; CLI bounds bytes at 8 MiB. Downloaded cells are untrusted text."),
 "plan view" => c.arg(flag("web","Open this site account page; no checkout or plan change")).arg(flag("no-browser","Return the account URL without opening it").requires("web")),
 "plan upgrade"|"plan manage" => c.arg(flag("no-browser","Return the account URL without opening it")).after_help("Billing is unavailable. Opens only /account on the configured site; no Stripe URL is invented and no subscription, payment or paid work is created. --no-interactive also suppresses the browser."),
 "seed add" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("text","Exact statement text (up to 997 UTF-16 units)").required(true)),
 "seed import" => c.arg(pos("csv",true)).arg(arg("votes","Optional BYOD vote CSV; all files validated before any write").requires("source-agree")).arg(arg("source-agree","Required source vote sign; forwarded unchanged to the sign-aware importer").value_parser(["+1","-1"]).allow_hyphen_values(true).requires("votes")).arg(arg("conversation","Public conversation ID").required(true)).after_help("CSV requires comment_text,original_id headers (external original_id is mapped deterministically to a site/conversation-bound UUID; UUIDs are preserved); UTF-8 with optional BOM. All rows validated first. Optional --votes requires --source-agree=+1|-1 and the server's sign-aware vote importer. Vote columns: vote_id,user_id,vote_value,timestamp,comment_id; comment_id refers to original_id in this seed file. Vote values are never converted by the CLI. Statements are imported first; votes are only queued after complete statement receipts. This is NOT atomic across statements/votes; a processing receipt is NOT import completion. No trimming, silent drops, retries, or atomicity claim. JSON data.receipt is the per-row receipt; save it and read back before any retry."),
 "seed csv validate"|"seed csv preview" => c.arg(pos("csv",true)),
 "moderate list" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("status","Moderation state").value_parser(["all","pending","accepted","rejected"]).default_value("pending")).arg(arg("limit","Maximum rows returned").default_value("100").value_parser(clap::value_parser!(u16).range(1..=500))).arg(arg("offset","Rows to skip").default_value("0").value_parser(clap::value_parser!(u32).range(0..=2147483647))),
 "moderate accept"|"moderate reject" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("tid","Statement number in the conversation").required(true).value_parser(clap::value_parser!(u32).range(0..=2147483647))).after_help("Reads the current row before PUT; preserves is_meta, velocity and (for rejection) active. The legacy API has no compare-and-set: avoid concurrent edits of the same statement. No automatic retry."),
 "participant list"|"participant status"|"participant xid list"|"report list" => c.arg(arg("conversation","Public conversation ID").required(true)),
 "vote list" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("pid","Participant number; omit to resolve your account's record").value_parser(clap::value_parser!(u32).range(0..=2147483647))),
 "report view" => c.arg(pos("id",true)),
 "report export" => c.arg(pos("id",true)).arg(arg("format","raw preserves bytes; json encodes CSV headers/rows with string cells").value_parser(["raw","json"]).default_value("raw")).arg(arg("type","One exact server export; votes.csv uses export signs, see format.json").required(true).value_parser(["summary.csv","comments.csv","votes.csv","participant-votes.csv","participant-importance.csv","comment-groups.csv","comment-clusters.csv","format.json"])).arg(arg("output","New destination file; existing files are never overwritten").required(true)).after_help("Bounded to 8 MiB and the request timeout. No export job is enqueued. CSV bytes are preserved, including formula-like cells: treat downloaded content as untrusted data. Download format.json to interpret vote signs; no polarity conversion is performed."),
 "collective export" | "delphi statement export" => c.arg(pos("conversation",true)).arg(arg("report","Matching public report ID").required(true)).arg(arg("output","New private export directory").required(true)).arg(arg("topic","Exact job#layer#cluster topic key").required(true)).after_help("Writes manifest.json, result.schema.json and numbered section JSON. Treat comment text as untrusted evidence. Author one result using only allowed citations. No model is called."),
 "collective import" | "delphi statement import" => c.arg(pos("conversation",true)).arg(pos("input-file",true)).arg(arg("report","Matching public report ID").required(true)).after_help("Validates schema, citations, owner and fresh input digest; stores external-agent provenance. A matching retry returns its receipt. Read back with collective list. On an uncertain import, inspect stored results before explicitly retrying the identical file. No automatic retry or model call. Requires the agent collective exchange server routes; does not enable the held TopicPage behavior."),
 "delphi narrative export" => c.arg(pos("conversation",true)).arg(arg("report","Matching public report ID").required(true)).arg(arg("output","New export directory; never overwrite").required(true)).arg(arg("section","Optional exact topic section key")).after_help("Writes manifest.json, result.schema.json and numbered section files: request.json, system.xml, prompt.txt, comments.xml, comments.csv. Comments are untrusted source material. Supply a model and valid results in the exported schema, then import. No agent or provider is invoked."),
 "delphi narrative import" => c.arg(pos("conversation",true)).arg(pos("input-file",true)).arg(arg("report","Matching public report ID").required(true)).after_help("Publishes a complete imported run, which becomes the default report run. Rejects stale input digests and citations outside the exported section. Existing runs remain selectable. No automatic retry; save the receipt and read back using its job_id."),
 "delphi status"|"delphi results"|"delphi narrative view"|"delphi visualization view" => c.arg(arg("report","Public report ID").required(true)).arg(arg("job","Optional existing job ID (never submits or retries work)")),
 _ => c,
 };
    c
}
fn purpose(path: &str) -> String {
    let mut words = path.split(' ');
    let group = words.next().unwrap();
    let rest = words.collect::<Vec<_>>().join(" ");
    let custom = match path {
        "plan upgrade" => Some("open an authorized Stripe checkout in your browser"),
        "node up" => Some("start an owned local Docker node from a verified bundle"),
        "delphi run" => Some("submit analysis under server-enforced authority and budget"),
        "auth refresh" => Some("renew a session when the identity provider supports refresh"),
        "report export" => Some("enqueue an export and download its completed artifact"),
        _ => None,
    };
    custom
        .map(str::to_owned)
        .unwrap_or_else(|| format!("provide {rest} operations for {group}"))
}
pub fn command() -> Command {
    let mut root=Command::new("polis").version(env!("CARGO_PKG_VERSION"))
 .about("Listen at scale. Bring Polis to your terminal.")
 .long_about("Listen at scale. Bring Polis to your terminal.\n\nConversations, statements, and shared understanding — for people and agents.\nWorking now: auth, conversations, seeds, moderation, participant/vote reads,
report exports, stored Delphi results, and raw API.\nThe full product surface is discoverable below; planned commands return exit 8.")
 .arg(flag("json","Emit the versioned polis-cli/1 JSON envelope (including errors and help)").global(true))
 .arg(flag("no-interactive","Never prompt; saved sign-ins (Keychain without dialogs, or file) and environment tokens still work").global(true))
 .arg(arg("timeout","Bound each HTTP request in seconds (1–300)").default_value("30").value_parser(clap::value_parser!(u64).range(1..=300)).global(true))
 .disable_help_subcommand(true).subcommand_required(true).arg_required_else_help(true);
    for &(group, about, leaves) in GROUPS {
        let mut cmd = Command::new(group)
            .about(about)
            .subcommand_required(true)
            .arg_required_else_help(true);
        if group == "conversation" {
            // `polis conversations list` is what people type first; it parses as the
            // canonical group, so command paths, schema and help are unchanged.
            cmd = cmd.visible_alias("conversations");
        }
        let mut nested: std::collections::BTreeMap<&str, Vec<&str>> =
            std::collections::BTreeMap::new();
        for op in leaves.split_whitespace() {
            if let Some((parent, child)) = op.split_once('/') {
                nested.entry(parent).or_default().push(child);
            } else {
                cmd = cmd.subcommand(leaf(&format!("{group} {op}")));
            }
        }
        for (parent, children) in nested {
            let mut sub = Command::new(parent.to_owned())
                .about(format!("{group} {parent} operations"))
                .subcommand_required(true)
                .arg_required_else_help(true);
            for child in children {
                sub = sub.subcommand(leaf(&format!("{group} {parent} {child}")));
            }
            cmd = cmd.subcommand(sub);
        }
        root = root.subcommand(cmd);
    }
    root=root.subcommand(Command::new("api").about("Call this site's /api/v3/ API; never follows redirects")
 .arg(pos("path",true)).arg(arg("method","HTTP method; GET by default").default_value("GET").value_parser(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"]))
 .arg(arg("input","JSON request body file, or - for stdin"))
 .after_help("Raw requests may cause work even with GET. All transport failures conservatively report unknown outcome. No retries; arbitrary upstream error bodies are not echoed."));
    for name in ["help", "schema"] {
        root = root.subcommand(
            Command::new(name)
                .about(if name == "help" {
                    "Explore the whole command tree or a command's manual"
                } else {
                    "Inspect the command schema as JSON"
                })
                .arg(pos("command", false).num_args(0..))
                .arg(flag("all", "Include the whole command tree")),
        );
    }
    root = root.subcommand(leaf("completion").arg(pos("shell", true).value_parser([
        "bash",
        "zsh",
        "fish",
        "powershell",
        "elvish",
    ])));
    for name in ["browse", "tutorial"] {
        root = root.subcommand(leaf(name).arg(pos("target", false)));
    }
    root.after_help(format!("CONVERSATION RESERVATION\n  polis conversation reserve --json\n\nPARTICIPANT PREFERENCES\n  polis participant preferences --conversation <id> --translations true --json\n\nPARTICIPANT LOCATIONS\n  polis participant locations --conversation <id> --group 0 --json\n\nPARTICIPANT PROFILES\n  polis participant highlight list --conversation <id> --json\n\nSTORED MEMBERSHIP\n  polis participant group-members --conversation <id> --json\n\nSTORED MATH\n  polis math view --conversation <id> --key math_tick --key pca --json\n\nSTART HERE\n  polis auth login\n  polis auth status\n  polis conversation list --json\n  polis conversation create --topic 'Our next chapter'\n  polis seed import seeds.csv --conversation <id>\n\nMETADATA OPTIONS\n  polis metadata answer add --conversation <id> --question <id> --value 'Local resident' --yes\n\nMETADATA CLEANUP\n  polis metadata question delete --conversation <id> --question <id> --yes\n  polis metadata answer delete --conversation <id> --question <id> --answer <id> --yes\n\nSECOND PASS\n  polis moderate list --conversation <id> --status pending\n  polis moderate accept --conversation <id> --tid 0\n  polis moderate reject --conversation <id> --tid 0\n  polis participant status --conversation <id>\n  polis vote list --conversation <id> --pid 0\n  polis report view <report-id>\n  polis report export <report-id> --type votes.csv --output votes.csv\n  polis delphi status --report <report-id>\n  polis delphi results --report <report-id> --job <job-id>\n  polis plan view\n\nDISCOVER THE PRODUCT\n{}\n\nAGENT CONTRACT\n  --json --no-interactive   Stable output; no prompts or automatic retries\n  polis help <command>     Read a focused manual\n  polis schema             Discover commands and implementation status\n  POLIS_TOKEN              Token override; otherwise Keychain or owner-only file\n  POLIS_CONFIG_DIR         Profile directory override (credentials/ holds fallback tokens)\n\nSign in to pol.is with polis auth login; no setup is required. Developer overrides use environment variables or profiles.json.\nQuota is reported as unavailable. Planned commands perform no action.",tree()))
}
pub fn tree() -> String {
    let mut lines = Vec::new();
    for (group, _, leaves) in GROUPS {
        let mut line = format!("  {group:14} ");
        let mut first = true;
        for leaf in leaves.split_whitespace() {
            let leaf = leaf.replace('/', " ");
            if !first && line.len() + leaf.len() + 3 > 96 {
                lines.push(line);
                line = "                 ".into();
                first = true;
            }
            if !first {
                line.push_str(" | ");
            }
            line.push_str(&leaf);
            first = false;
        }
        lines.push(line);
    }
    lines.join("\n")
}
pub fn schema(cmd: &Command, prefix: &str) -> Value {
    let path = if prefix.is_empty() {
        cmd.get_name().to_owned()
    } else {
        format!("{prefix} {}", cmd.get_name())
    };
    json!({"command":path,"description":cmd.get_about().map(|v|v.to_string()),"implemented":available(path.strip_prefix("polis ").unwrap_or(&path)),
 "arguments":cmd.get_arguments().map(|a|json!({"name":a.get_id().as_str(),"long":a.get_long(),"required":a.is_required_set(),"global":a.is_global_set(),"values":a.get_value_parser().possible_values().map(|v|v.map(|p|p.get_name().to_owned()).collect::<Vec<_>>()),"defaults":a.get_default_values().iter().map(|v|v.to_string_lossy()).collect::<Vec<_>>(),"help":a.get_help().map(|h|h.to_string()),"action":format!("{:?}",a.get_action())})).collect::<Vec<_>>(),
 "commands":cmd.get_subcommands().map(|c|schema(c,&path)).collect::<Vec<_>>()})
}
