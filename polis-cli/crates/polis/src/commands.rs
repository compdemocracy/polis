use clap::{Arg, ArgAction, ArgGroup, Command};
use serde_json::{json, Value};

// One declaration drives parser, nested help, full command tree, and JSON schema.
const GROUPS: &[(&str, &str, &str)] = &[
 ("auth", "Sign in and inspect your session", "login status logout token refresh"),
 ("account", "Your identity and organization", "view edit invite verify"),
 ("conversation", "Create and explore conversations", "new create reserve list view edit close reopen stats activity snapshot uuid email-link share"),
 ("seed", "Prepare and import seed comments", "add import csv/validate csv/preview csv/normalize"),
 ("comment", "Read and contribute participant comments", "list view stats add next translations flag upvote star trash"),
 ("vote", "Participate with agree, disagree, or pass", "cast list import csv/validate csv/convert"),
 ("moderate", "Review comments as a moderator", "list accept reject set"),
 ("participant", "Participation, groups, and access lists", "login status list export activity preferences group group-members query locations highlight/list highlight/set xid/list xid/export allowlist/view allowlist/import allowlist/export"),
 ("invite", "Invite people and manage invitation waves", "code/list code/create wave/list wave/create list export status revoke"),
 ("metadata", "Conversation questions and choices", "view choices question/list question/add question/delete answer/list answer/add answer/delete"),
 ("context", "Browse and create conversation contexts", "list create"),
 ("notification", "Manage conversation subscriptions", "subscribe unsubscribe set"),
 ("report", "Publish and explore reports", "list create view edit comments/list comments/select stats topics visualization export feed/list feed/consensus feed/topics"),
 ("math", "Inspect the conversation's mathematical summary", "view correlation refresh"),
 ("topic", "Explore topic structure and comments", "list comments hierarchy proximity stats prioritize moderate"),
 ("agenda", "Choose and manage topic priorities", "priorities list add replace remove"),
 ("delphi", "Run analysis and read stored results", "run status results logs wait show narrative/run narrative/view narrative/export narrative/import statement/export statement/import visualization/view"),
 ("collective", "Generate and read collective statements", "generate list view statements export import"),
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
    crate::admin::available(path)
        || matches!(
            path,
            "comment"
                | "join"
                | "vote"
                | "conversation reserve"
                | "invite code create"
                | "invite wave create"
                | "invite code list"
                | "invite wave list"
                | "invite list"
                | "invite export"
                | "invite status"
                | "conversation uuid"
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
                | "comment stats"
                | "comment list"
                | "comment view"
                | "collective list"
                | "collective view"
                | "collective statements"
                | "topic list"
                | "topic comments"
                | "topic hierarchy"
                | "topic proximity"
                | "topic stats"
                | "topic prioritize"
                | "report topics"
                | "report stats"
                | "report comments list"
                | "account view"
                | "conversation edit"
                | "conversation share"
                | "conversation stats"
                | "report create"
                | "auth login"
                | "auth status"
                | "auth logout"
                | "auth token"
                | "conversation new"
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
                | "delphi show"
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
                | "questions"
                | "tutorial"
                | "api"
                | "schema"
                | "help"
                | "agent guide"
        )
}
fn leaf(path: &str) -> Command {
    if let Some(command) = crate::admin::command(path) {
        return command;
    }
    let name = path.split(' ').next_back().unwrap();
    let about = match path {
        "invite code create" => "Add a public conversation code and verify it by reading back",
        "invite wave create" => "Create an invitation wave and verify it by reading back",
        "invite code list" => "List the conversation's public codes as its owner",
        "invite wave list" => "List invitation waves",
        "invite list" => "List owner invitation codes, optionally filtered by status and wave",
        "invite export" => "Download owner invitation codes to a new private CSV file",
        "invite status" => "Read invite-only settings, waves and owner-code counts",
        "conversation uuid" => {
            "Print the secret key that unlocks the participant-XID export; may mint it"
        }
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
        "comment stats" => "Which comments divided the room the most?",
        "comment list" => "Page through participant-visible comments in a conversation",
        "comment view" => "Read one participant-visible comment by its conversation-local number",
        "collective list" => {
            "Read stored collective statements, deduplicated by the server by topic"
        }
        "collective view" => "Read one stored collective statement by its exact opaque ID",
        "collective statements" => "Read each topic's stored collective statement for a report",
        "topic list" | "report topics" => {
            "Read stored topics, retaining unavailable moderation markers"
        }
        "topic comments" => "Read comments by exact topic key; missing stores are errors",
        "topic hierarchy" => "Read the stored topic hierarchy; no analysis starts",
        "topic proximity" => "Read stored topic coordinates for a layer or all layers",
        "topic stats" => "Read topic moderation counts and their availability",
        "topic prioritize" => "Choose the topics that matter most to you, as a participant",
        "report stats" => "Read participation timing through a matching report capability",
        "report comments list" => "Page through visible comments with report-selection fields",
        "account view" => "Read the signed-in account from this site's users API",
        "conversation edit" => {
            "Edit moderator settings, preserve legacy defaults, then verify them"
        }
        "conversation share" => "Format participation and admin share links locally; sends nothing",
        "conversation stats" => {
            "Read moderator-authorized participation statistics, bounded to 8 MiB"
        }
        "report create" => "Create report configuration as moderator; no analysis is started",
        "auth login" => "Sign in in your browser with PKCE; save the sign-in in an owner-only file",
        "auth token" => "Print the access token (secret) for the selected site; refresh if needed",
        "auth status" => "Check the saved sign-in with the server",
        "auth logout" => "Revoke the saved refresh token, then clear the local sign-in",
        "conversation new" => "Start a conversation with a typed setup wizard or file",
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
        "questions" => {
            "Find questions worth asking about a conversation, and commands to answer them"
        }
        "seed add" => "Add one seed comment through the moderator-enforced bulk API",
        "seed import" => "Validate a CSV, then import its seed comments as moderator",
        "seed csv validate" => "Validate UTF-8 CSV headers, lengths, duplicates, and row counts",
        "seed csv preview" => "Show the exact validated comments without submitting them",
        "moderate list" => "Read the moderation queue with limit and offset",
        "moderate accept" => "Accept one comment, preserving its current metadata",
        "moderate reject" => "Reject one comment, preserving its current metadata",
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
        "delphi show" => {
            "Show a report's collective statements and topic statistics for one model's run"
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
 "invite code list" | "invite status" => c.arg(arg("conversation", "Public conversation ID").required(true)).after_help("Invite codes are credentials. Code order is unspecified. Status uses separate reads, not an atomic snapshot; participant-owned codes are not counted."),
 "invite code create" => c.arg(arg("conversation", "Public conversation ID").required(true)).arg(flag("short", "Ask Node for a short code")).after_help("Adds a code without retiring existing codes. Makes one write and one read-back; no automatic retries. Exit 7 means the outcome is uncertain: inspect codes before retrying."),
 "invite wave create" => c.arg(arg("conversation", "Public conversation ID").required(true)).arg(arg("per-user", "Invites per parent-wave participant").required(true).value_parser(clap::value_parser!(u32).range(0..=2147483647))).arg(arg("owner-invites", "Owner invitation count").required(true).value_parser(clap::value_parser!(u32).range(0..=2147483647))).arg(arg("parent-wave", "Parent wave number; omit to use Node's latest wave").value_parser(clap::value_parser!(u32).range(0..=2147483647))).after_help("At least one invite count must be positive. Node may partially create a wave before failing. Makes one write and one read-back; exit 7 requires inspection before any retry. Read-back confirms the wave row, not an atomic snapshot of all invite rows."),
 "invite wave list" => c.arg(arg("conversation", "Public conversation ID").required(true)).arg(arg("wave", "Wave number").value_parser(clap::value_parser!(u32).range(0..=2147483647))),
 "invite list" => c.arg(arg("conversation", "Public conversation ID").required(true)).arg(arg("wave-id", "Wave database ID").value_parser(clap::value_parser!(u64).range(1..=9007199254740991))).arg(arg("status", "Owner-code status").value_parser(["unused", "used", "revoked", "expired"])).arg(arg("limit", "Page size").default_value("50").value_parser(clap::value_parser!(u32).range(1..=500))).arg(arg("offset", "Page offset").default_value("0").value_parser(clap::value_parser!(u32).range(0..=2147483647))).after_help("Reads conversation settings and one page. An empty page does not prove invite-only is enabled. pagination.hasMore uses the server's field name. Codes are credentials; reads are not an atomic snapshot."),
 "invite export" => c.arg(arg("conversation", "Public conversation ID").required(true)).arg(arg("output", "New private CSV file; never overwrite").required(true)).after_help("Downloads all owner codes with no filter or pagination. Bytes are preserved, including formula-like cells; treat CSV as untrusted data. Codes are credentials. Bounded to 8 MiB and --timeout."),
 "conversation uuid" => c.arg(pos("id",true)).after_help("SECRET: anyone holding this key can download participant XIDs. Prints the raw key on stdout, or data.conversation_uuid with --json. The server may mint a key on first read; no automatic retry. Requires the site's moderator authority."),
 "conversation reserve" => c.after_help("EXAMPLE\n  polis conversation reserve --json\n\nOne authenticated POST requests a new ID. Legacy compatibility requires a conversation row at zid=0; a fresh database lacks it and returns a server failure. The CLI does not create that row. The legacy server registers it with zid=0: no conversation is created and no owner is bound. The ID is not proof of ownership or exclusive access. Preserve the receipt for a later explicit API creation request; conversation create does not yet accept a reserved ID. No lookup, release, expiry or idempotency contract is exposed. Every invocation can allocate another ID; no automatic retry or readback. If the response is lost, ask the site operator to inspect reservations before retrying. Responses are bounded to 8 MiB and --timeout."),
 "participant preferences" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("translations","Store translation display preference for the signed-in account").required(true).value_parser(["true","false"])).after_help("EXAMPLES\n  polis participant preferences --conversation CONV --translations true --json\n  polis participant preferences --conversation CONV --translations false --json\n\nSets show_translation_activated for the signed-in account in this conversation. Requires an explicit true or false; no participant ID, XID or another-account target is accepted. This changes a stored display preference only; no translation, model call or vote is requested. Sends one PUT, with no automatic retry. The legacy API returns an empty array even when no participant preference row exists. Success therefore reports state=acknowledged, affected_rows=null and persistence=unverified; it does not prove the value changed or create/join a participant. There is no preference readback endpoint. Ask the site operator to inspect this account's stored preference before retrying an uncertain write. Existing participant status does not read this preference. Requires site sign-in; 8 MiB response bound and --timeout apply."),
 "participant locations" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("group","Opinion-group array index, not its stored id or a base-cluster index").required(true).value_parser(clap::value_parser!(u32).range(0..=2147483647))).after_help("EXAMPLE\n  polis participant locations --conversation CONV --group 0 --json\n\nPublic read of stored participant coordinates for one opinion-group ARRAY INDEX in the site math, not its stored id or a base-cluster index. Rows contain lat, lng and n=1; duplicates and server order are preserved, with no identities added. Empty can mean no matching locations, absent math, a refused math bundle or an absent group: it does not prove no participants. The server may cache math and reads locations separately; no generation, freshness, full-population or cross-read coherence is promised. Optional saved credentials apply. Coordinates are untrusted stored data; no geocoding, map lookup, aggregation, writes, computation or retry. One bounded request, 8 MiB and --timeout. Non-finite or out-of-range coordinates are refused as invalid_response, never clipped or dropped."),
 "participant highlight list" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("mod","Exact stored participant moderation integer; omit for all values").allow_hyphen_values(true).value_parser(clap::value_parser!(i32))).after_help("EXAMPLES\n  polis participant highlight list --conversation CONV --json\n  polis participant highlight list --conversation CONV --mod 1 --json\n\nReads the existing participant-profile route. Only participants with an owner-associated XID and non-null profile image are returned. Without --mod all stored moderation values are eligible; --mod filters the exact signed integer, not comment moderation or an opinion-group ID. Empty can mean no matching profiles OR withheld access: the server exposes rows only to the exact owner, a Polis developer, or anyone when conversation data is open. A same-site moderator is not necessarily the owner. No roster completeness, stable order or pagination claim: the server caps candidates at 99999 before profile filtering. Profile text and URLs are untrusted data; URLs are never fetched. Optional saved credentials apply. One bounded read, 8 MiB and --timeout; no writes, retries or computation. Use participant highlight set for an explicitly confirmed write."),
 "participant group-members" => c.arg(arg("conversation","Public conversation ID").required(true)).after_help("EXAMPLE\n  polis participant group-members --conversation CONV --json\n\nPublic read of the base-cluster index to participant-ID map (bidToPid). Array positions are base-cluster indices, not opinion-group IDs. This is not a complete participant roster. No sign-in required; configured credentials still apply. No computation, refresh, conditional request, cache or automatic retry. Missing math returns membership_unavailable, not an empty list; the legacy API also masks storage errors as 304. An empty stored map is a valid result. No generation is returned, so do not join this result to a separate math read or claim freshness/coherence. Member order and empty clusters are preserved. Responses are bounded to 8 MiB and --timeout."),
 "comment stats" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("sort","Rank descending; unknown values last; ties by comment number").value_parser(["agree","disagree","pass","divisive","consensus","important","votes"]).default_value("divisive")).arg(flag("by-group","Show each opinion group's split as well as the total")).after_help("EXAMPLES\n  polis comment stats --conversation CONV --sort disagree\n  polis comment stats --conversation CONV --sort consensus --by-group --json\n\nWhich comments divided the room the most? Default: divisiveness = 1 - |agree-disagree|/(agree+disagree). Percentages use all votes, including pass; pass = seen - agree - disagree. Consensus is the lowest agree percentage across every observed group, not the engine's consensus score. Sorts descend, unknowns last, ties by tid. Inspect sample sizes: no significance claim.\n\nReads served math/pca2 group-votes, complete participant-visible comment pages, and current importance counts. Only grouped participants are counted; no all-participant claim. Missing math totals are unknown, not zero. Zero-vote percentages and all-pass divisiveness are unknown. Missing importance is omitted with a note; --sort important fails if that read is unavailable. Per-group output uses stored group IDs, not array indices.\n\nText is truncated only in the terminal; --json uses the normal CLI envelope with data.schema=comment-stats/1, full text and data.reads[].body containing each successful decoded response as an exact UTF-8 string (parse the string to read its JSON). Terminal-safe JSON escaping preserves its decoded bytes. No claim of byte-identical HTTP headers or compressed wire bytes. See polis-cli/COMMENT-STATS.md for the envelope and formulas.\n\nEach response is bounded to 8 MiB and --timeout; at most 10000 comments, 1000 groups, 100000 comment-by-group cells and 32 MiB combined successful bodies. Full-page ranking, never a partial top list. Reads are sequential, separate snapshots; no automatic retry, writes or computation. Input is validated before credentials."),
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
  c.after_help("EXAMPLES\n  polis metadata question list --conversation CONV --json\n  polis metadata answer list --conversation CONV --question 1 --json\n\nReads active questions or answer options through the public API, with optional saved credentials. Answer options are not participant responses. The current server forces required=true on questions and is_exclusive=true on options; these are legacy response flags, not verified configuration. Rows and text are preserved as untrusted data; an exact --question filter is verified. Empty lists succeed. No pagination, invitation credential or write is sent. Bounded to 8 MiB and --timeout; metadata_read_failed identifies upstream read failures. Metadata view/choices use the participant-scoped routes. Question creation, confirmed answer creation/reactivation and confirmed question/answer soft deletion are available.")
 },
 "context list" => c.after_help("EXAMPLE\n  polis context list --json\n\nLists public context names in server order, with optional saved credentials. Private contexts are excluded, even for their creator. No pagination or creation occurs; empty lists succeed. Names remain unchanged and are untrusted data. Bounded to 8 MiB and --timeout; contexts_read_failed identifies upstream read failures."),
 "comment list" | "comment view" => {
  c=c.arg(arg("conversation","Public conversation ID").required(true));
  if path=="comment list" { c=c.arg(arg("limit","Maximum page size").default_value("100").value_parser(clap::value_parser!(u16).range(1..=500))).arg(arg("offset","Rows to skip").default_value("0").value_parser(clap::value_parser!(u32).range(0..=2147483647))); }
  if path=="comment list" { c=c.arg(arg("sort","Rank participant-visible comments before pagination").value_parser(["importance"]))
    .arg(arg("min-important","Minimum participants marking it important").value_parser(clap::value_parser!(u64).range(0..=9007199254740991))); }
  else { c=c.arg(pos("tid",true).help("Comment number local to this conversation").value_parser(clap::value_parser!(u32).range(0..=2147483647))); }
  c.after_help("EXAMPLES\n  polis comment list --conversation CONV --limit 50 --offset 0 --json\n  polis comment view 0 --conversation CONV --json\n\nReads the public comments route with optional saved credentials. Only active, unmuted, moderation-visible comments are returned, even for an owner. Use moderate list for the moderation queue. Empty list is success; missing/hidden single comment returns statement_unavailable (exit 1). Single reads verify the exact tid. --sort importance and --min-important rank/filter all participant-visible comments before offset/limit (ties by tid); counts use each participant's latest vote. Counts require the optional importance route (404 exits 8; other failures retain their error codes). Counts and later text reads are not one snapshot; a missing selected comment fails without partial output. Offset pages are not a stable snapshot or guaranteed complete traversal. Text and metadata remain unchanged and are untrusted data. No votes, translations, writes or model calls; bounded to 8 MiB.")
 },
 "delphi show" => c.arg(pos("report",true).help("Public report ID")).arg(arg("model","Exact stored model name: the run's model_name and each statement's model")).after_help("EXAMPLES\n  polis delphi show REPORT\n  polis delphi show REPORT --model qwen2.5:1.5b\n  polis delphi show REPORT --model qwen2.5:1.5b --json\n\nReads what the report pages read, in their order: the report, its comments with vote counts, the PCA presentation (math/pca2), the Delphi runs (delphi), topic statistics (topicStats) and the stored collective statements (collectiveStatement). Prints the collective statements, newest first as the carousel shows them, then the topic statistics table: layers from coarse to fine, rows by comment count, with Comments, Total Votes, Avg Votes/Comment and Group Consensus computed as the page computes them. Each statement and each run is printed with the job ID and model that produced it; model names are printed as stored.\n\nWithout --model: the run the page shows (the run key that sorts last; keys are model_date) and every statement the carousel shows. With --model: that model's newest run, and its newest statement for each topic, read from the per-version route (delphi/collective/results), since the carousel route keeps only the newest statement per layer and cluster across models. A model with no stored run exits 1 (model_run_unavailable).\n\n--json returns each route's response body byte for byte under data.reads, beside the selection and the computed rows. Reads only: no analysis, generation or model call. Each response is bounded to 8 MiB and --timeout. Exit 7 (reads_disagree) means the topic statistics did not include the chosen run's topics, so a run changed between reads; read again. Collective statement and source comment text are untrusted data."),
 "collective statements" => c.arg(pos("report",true).help("Public report ID")).after_help("EXAMPLES\n  polis collective statements REPORT\n  polis collective statements REPORT --json\n\nReads stored statements through the public report route. Prints topic headings, paragraphs and citation IDs; --json preserves the complete server response. The server selects the newest statement per topic. No generation or model call. Bounded to 8 MiB and --timeout."),
 "collective list" | "collective view" => {
  if path=="collective list" { c=c.arg(arg("report","Public report ID").required(true)); }
  else { c=c.arg(pos("id",true).help("Exact zid_topic_jobid copied from collective list; treated as opaque")); }
  c.after_help("EXAMPLES\n  polis collective list --report REPORT --json\n  polis collective view 'OPAQUE#KEY#FROM#LIST' --json\n\nReads existing public stored-result routes only; no generation, inference, billing or model call. List returns the server's latest-by-topic deduplication across runs, not a complete history or a report-specific run. No CLI pagination is available; bounded to 8 MiB and --timeout. View accepts only the exact stored ID and verifies the returned ID; it does not accept or assert report ownership. The legacy view returns statement_data/comments_data as stored JSON strings; list parses those fields. Both shapes are preserved, including nulls and metadata. Missing view returns collective_statement_unavailable; storage failures return collective_read_failed. Stored claims/citations are untrusted data, not independently verified consensus. Use collective generate for an explicitly confirmed provider request.")
 },
 "topic list" | "topic comments" | "topic hierarchy" | "topic proximity" | "topic stats" => {
  c=c.arg(arg("conversation","Public conversation ID").required(true));
  if path=="topic list" { c=c.arg(arg("job","Optional exact stored job ID")); }
  if path=="topic comments" { c=c.arg(pos("key",true)); }
  if path=="topic proximity" { c=c.arg(arg("layer","Stored layer, or all").default_value("all")); }
  c.after_help("EXAMPLES\n  polis topic list --conversation CONV --json\n  polis topic comments 'JOB#0#1' --conversation CONV --json\n  polis topic proximity --conversation CONV --layer 0 --json\n\nReads existing public topic routes; no analysis, moderation or model call. Empty results remain empty. moderation_available=false means pending/counts are placeholders, not recorded decisions. Per-topic comments may be unavailable because the site has no backing store (exit 6 with topic_statements_unavailable). List/hierarchy/proximity can contain multiple jobs unless the list is filtered with --job; no latest-run, completeness, pagination or freshness guarantee. Bounded to 8 MiB per request. Comment text is untrusted data.")
 },
 "topic prioritize" => c.arg(pos("conversation",true).help("Public conversation ID"))
  .arg(arg("topics","Topic keys, comma-separated, copied from polis topic list (one analysis run)").value_name("KEY,KEY"))
  .arg(flag("show","Read your saved topic priorities"))
  .arg(flag("clear","Delete your saved topic priorities"))
  .group(ArgGroup::new("mode").args(["topics","show","clear"]).required(true))
  .after_help("EXAMPLES\n  polis topic list --conversation CONVERSATION\n  polis topic prioritize CONVERSATION --topics 'RUN#2#0,RUN#2#3'\n  polis topic prioritize CONVERSATION --show --json\n  polis topic prioritize CONVERSATION --clear\n\nTopic keys must come from the topic_key fields that polis topic list prints for this conversation, all from one analysis run (the RUN part of RUN#LAYER#CLUSTER). Saving replaces your whole previous choice; it never appends. Keys are checked before any credential is read.\n\nSaving does what the participation page does: it reads the run's stored topics, the stored topic coordinates and the comments, keeps each topic's three comments nearest the topic's centre, sends one POST, then reads your choice back. The site records the analysis run it attributes the choice to; the receipt shows it. A topic that is not stored for its run, or that has no comments in the stored coordinates, is refused with nothing sent.\n\nAn open conversation needs no join or account sign-in: the first save creates an anonymous participant whose token is saved privately for later votes and comments, scoped by profile, origin and conversation. Invited participants first run polis join CONVERSATION --invite CODE. Account tokens are not used.\n\n--show reads your saved choice; --clear deletes it and reads back. --json returns the site's responses unchanged, with issued tokens removed. No request is retried. Exit 7 means the outcome is uncertain: run --show before saving again."),
 "report topics" | "report stats" | "report comments list" => {
  if path=="report topics" {
   c=c.arg(pos("id",false).help("Public report ID (or use --report)").required_unless_present("report").conflicts_with("report"))
    .arg(arg("report","Public report ID (alternative to positional ID)").required_unless_present("id"))
    .arg(arg("job","Optional exact stored job ID"));
  } else { c=c.arg(pos("id",true)); }
  if path=="report stats" { c=c.arg(arg("until","Exclusive positive UTC epoch-millisecond cutoff").value_parser(clap::value_parser!(u64).range(1..=9007199254740991))); }
  if path=="report comments list" { c=c.arg(arg("limit","Maximum page size").default_value("100").value_parser(clap::value_parser!(u16).range(1..=500))).arg(arg("offset","Rows to skip").default_value("0").value_parser(clap::value_parser!(u32).range(0..=2147483647))); }
  c.after_help("EXAMPLES\n  polis report topics REPORT --json\n  polis report topics --report REPORT --job JOB --json\n  polis report stats REPORT --until 1791417600000 --json\n  polis report comments list REPORT --limit 50 --offset 0 --json\n\nResolves exactly one matching report to its conversation before reading; no separately supplied conversation can be paired with it. Uses existing public/report-capability access; saved optional credentials still apply. Comments are participant-visible rows, not every moderator row or a selected-only list; important/voters are current participant-visible comment counts using each participant's latest vote, with read_at_ms. Null means unavailable or not visible at that read, never zero. Counts are not historical report inputs; includeInReport is retained exactly and omitted values are not inferred. Pagination is offset-based, not a stable snapshot. Stats are historical event timing, not latest votes or math freshness. Topics are conversation-wide stored data, not a report-specific run unless --job is supplied. No write or analysis starts; each request is bounded to 8 MiB.")
 },
 "auth login" => c.arg(flag("device","Sign in on another device with a browser").conflicts_with_all(["browser","no-browser","with-token","token-stdin","no-store"]))
    .arg(flag("with-token","Read a bearer token from stdin and save to a 0600 file").conflicts_with_all(["token-stdin","browser","no-browser"]))
    .arg(flag("browser","Start a fresh browser sign-in").conflicts_with("token-stdin"))
    .arg(flag("no-browser","Print the browser login URL for this machine").conflicts_with("token-stdin"))
    .arg(flag("token-stdin","Read an access token from stdin"))
    .arg(flag("no-store","Validate stdin token without storing it").requires("token-stdin"))
    .after_help("Browser login uses Authorization Code + S256 PKCE. --device signs in from a different browser without a callback listener. Both request offline_access. Access/refresh credentials are saved in an owner-only 0600 file under a 0700 directory on every supported platform. POLIS_KEYCHAIN=on explicitly opts into macOS Keychain; unset or off never calls it, even to migrate an old sign-in. A Keychain-only sign-in appears signed out: run polis auth login once to save a new file sign-in. Opted-in Keychain calls also suppress dialogs. Refresh is silent before expiry; revoked refresh credentials require a new sign-in. --no-interactive never shows browser or Keychain dialogs; device authorization still needs approval on another device. auth token explicitly prints a secret. auth logout POSTs the saved refresh token and its client ID to the revocation_endpoint advertised by the saved issuer's discovery document, then clears local credentials. Without that endpoint, logout reports not_available and succeeds locally. Revocation failures report oauth_revoke_failed (exit 7, outcome unknown) after local cleanup; no automatic retry. Manual tokens have no refresh token to revoke. The provider browser session is unchanged. POLIS_TOKEN overrides stored credentials (POLIS_TOKEN_<PROFILE> for developer profiles)."),
 "conversation edit" => c.arg(pos("id",true)).arg(arg("topic","New topic, 1–1000 UTF-16 units; exact text preserved")).arg(arg("description","New description, up to 50000 UTF-16 units; empty string clears it")).arg(arg("draft","Draft state; explicit true or false").value_parser(["true","false"])).arg(arg("data-open","Public data setting; explicit true or false").value_parser(["true","false"])).arg(arg("strict-moderation","Require moderation; explicit true or false").value_parser(["true","false"])).arg(arg("invite-only","Require invitation membership; explicit true or false").value_parser(["true","false"])).arg(arg("external-id","External-ID check: optional, required (fresh identities need one) or allowlist (every join, vote and comment is checked against the list)").value_parser(polis_contracts::setup::ExternalIdentityMode::NAMES)).after_help("EXAMPLES\n  polis conversation edit CONV --topic 'Our shared priorities'\n  polis conversation edit CONV --description '' --draft true --json\n  polis conversation edit CONV --invite-only false --external-id required\n\nRequires moderator access. Reads current settings to preserve the five flags that the legacy PUT defaults to false. Refuses incomplete settings before writing. No compare-and-set: coordinate concurrent moderator edits. Verifies requested and preserved flags; failed readback exits 7. No email, ID rotation or automatic retry.\n\nADMISSION\n  --invite-only and --external-id change only what is given. --external-id allowlist switches the list check on; it does not change the listed IDs, which conversation new sets (participant allowlist import is planned). The allow-list setting is fixed once participation has started: Node refuses a change after a participant from outside the owner's site has joined (exit 5, xid_allowlist_fixed), and it is never retried. Read the setup admission model in docs/conversation-setup.md for which identities each check reaches."),
 "conversation share" => c.arg(pos("id",true)).after_help("EXAMPLE\n  polis conversation share CONV --json\n\nReturns participation_url and admin_share_url for the configured site. Links are unverified: this performs no HTTP request and changes no access. It never emails, opens a browser, creates an invitation or discloses a saved token."),
 "conversation stats" => c.arg(pos("id",true)).arg(arg("until","Exclusive UTC epoch-millisecond cutoff, positive safe integer").value_parser(clap::value_parser!(u64).range(1..=9007199254740991))).after_help("EXAMPLES\n  polis conversation stats CONV --json\n  polis conversation stats CONV --until 1791417600000 --json\n\nRequires this site's moderator permission. Returns the existing vote/comment timing and histogram fields unchanged; these are historical event statistics, not unique latest votes or math freshness. No pagination; bounded to 8 MiB and the request timeout. No report-ID permission fallback."),
 "report create" => c.arg(arg("conversation","Public conversation ID").required(true)).after_help("EXAMPLE\n  polis report create --conversation CONV --json\n  polis report list --conversation CONV --json\n\nRequires moderator access. Creates report configuration with the existing default mod_level=-2; starts no math, export or Delphi generation. data.report_id is the created report's ID when the server returns it; servers that reply {} leave it null, and data.reports is then an uncorrelated readback list, never proof of which report was created. There is no idempotency key. A failed readback preserves the accepted receipt. Never repeat creation to recover a lost ID; list first. An uncertain write exits 7."),
 "account view" => c.after_help("EXAMPLE\n  polis account view --json\n\nRequires authentication. Returns this account's server profile, which may include personal data. It is not a plan, credit balance, or proof of permission for another resource."),
 "conversation new" => c.arg(arg("from","Read a typed setup JSON file instead of asking questions")).arg(arg("save","Write the typed setup to a new private file")).arg(flag("dry-run","Describe setup without any HTTP requests")).after_help("EXAMPLES\n  polis conversation new\n  polis conversation new --from setup.json --dry-run --json\n  polis conversation new --from setup.json --json\n\nUses the same typed model for people and agents. Invalid settings fail before writes. The interactive wizard shows a summary and asks before applying. Creates a staged closed conversation, applies settings, invitation waves, external-ID allowlist and initial comments, reads back each step, then applies the final participation settings. Partial failure exits 7 with completed steps and, in data.finish, the commands that finish the staged closed, invite-only conversation; never blindly rerun new, which creates another conversation. A refused first create made nothing and exits with its own code. Initial comments use the moderator bulk endpoint with no seed flag or automatic vote. No server permissions are changed. See docs/conversation-setup.md for current behavior and proposed improvements."),
 "conversation create" => c.arg(arg("topic","Conversation topic (1–1000 UTF-16 units)").required(true)).arg(arg("description","Optional description (up to 50000 UTF-16 units)")).arg(flag("draft","Create a draft")),
 "conversation list" => c.arg(flag("mine","Owned conversations only (the default)")).arg(flag("recent","Newest created first (the default)")).arg(arg("limit","Rows read from the site before the owner filter (1–9999)").default_value("100").value_parser(clap::value_parser!(u16).range(1..=9999))).arg(arg("active","Filter active or closed").value_parser(["true","false"])).arg(arg("draft","Filter draft or published").value_parser(["true","false"])).arg(arg("search","Case-insensitive topic substring (literal), applied to the rows read")).arg(arg("sort","Creation date (newest/oldest) or size (participants/statements/votes, largest first)").value_parser(["newest","oldest","participants","statements","votes"])).arg(flag("sizes","Read per-conversation statistics and show size columns")).arg(arg("min-participants","Minimum stored participant count; uses the Rust owner list").value_parser(clap::value_parser!(u32).range(0..=2147483647))).arg(arg("cursor","Opaque next_cursor from the same owner and filters; uses the Rust owner list")).after_help("EXAMPLES\n  polis conversation list --json\n  polis conversation list --limit 500 --active true --json\n  polis conversation list --search 'budget' --json\n\nReads GET /api/v3/conversations. The current API returns an array of the conversations this account owns or shares a site with, newest created first, at most --limit rows; it has no offset, cursor, owner filter or search parameter. Rows whose server-set is_owner is false are dropped here, so pagination.returned can be below pagination.server_rows. pagination.truncated is true when the site returned --limit rows: raise --limit to read more. --active and --draft are applied by the site; --search is a literal, case-insensitive topic match applied to the rows read. Requires sign-in. Bounded reads, 8 MiB and --timeout; no automatic retry.\n\nWithout --json the result is a table: topic and description (cleaned and cut to fit the terminal), the conversation URL and the newest report URL, with +N when the conversation has N more reports. The report column comes from a second, best-effort GET /api/v3/reports: if that read fails, the table still prints with an empty column and one warning on stderr. --json reads only the conversations route and returns the data envelope unchanged.\n\nSupplying --sort newest/oldest, --min-participants or --cursor selects the separately enabled Rust owner-list endpoint and requires an OIDC access token. That mode supports server-side search, a limit of at most 500, and opaque cursor pagination. Repeat filters on each page. It never falls back to an unfiltered list. Stored participant counts and pagination are not a frozen snapshot.\n\n--sizes or --sort participants|statements|votes uses the existing list plus one sequential conversationStats read per returned owned row (maximum --limit 500). Size sorting is descending within those returned rows, NOT a global ranking; ties keep site order. Participants counts distinct voters (including author votes), statements counts all stored comments including moderated/seeds, votes counts vote records including revotes. These differ from the stored participant_count, which is preserved in JSON. --sizes preserves site order. Each read retains the 8 MiB and --timeout bounds; a failed or invalid stats read fails the command, with no partial ranking. Counts are separate reads, not a snapshot. Size options cannot be combined with cursor/min-participants or --recent. No size reads occur unless requested."),
 "conversation view" | "conversation close" | "conversation reopen" => c.arg(pos("id",true)),
 "participant export"|"participant xid export" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("output","New output file; never overwrite").required(true)).arg(arg("format","CSV preserves bytes; JSON retains every CSV cell as a string").value_parser(["csv","json"]).default_value("csv")).after_help("Uses the moderator-enforced XID export. Only participants with XIDs are included, not every participant. Server caps this endpoint at 1,000,000 rows; CLI bounds bytes at 8 MiB. Downloaded cells are untrusted text."),
 "plan view" => c.arg(flag("web","Open this site account page; no checkout or plan change")).arg(flag("no-browser","Return the account URL without opening it").requires("web")),
 "plan upgrade"|"plan manage" => c.arg(flag("no-browser","Return the account URL without opening it")).after_help("Billing is unavailable. Opens only /account on the configured site; no Stripe URL is invented and no subscription, payment or paid work is created. --no-interactive also suppresses the browser."),
 "seed add" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("text","Exact comment text (up to 997 UTF-16 units)").required(true)),
 "seed import" => c.arg(pos("csv",true)).arg(arg("votes","Optional BYOD vote CSV; all files validated before any write").requires("source-agree")).arg(arg("source-agree","Required source vote sign; forwarded unchanged to the sign-aware importer").value_parser(["+1","-1"]).allow_hyphen_values(true).requires("votes")).arg(arg("conversation","Public conversation ID").required(true)).after_help("CSV requires comment_text,original_id headers (external original_id is mapped deterministically to a site/conversation-bound UUID; UUIDs are preserved); UTF-8 with optional BOM. All rows validated first. Optional --votes requires --source-agree=+1|-1 and the server's sign-aware vote importer. Vote columns: vote_id,user_id,vote_value,timestamp,comment_id; comment_id refers to original_id in this seed file. Vote values are never converted by the CLI. Comments are imported first; votes are only queued after complete comment receipts. This is NOT atomic across comments/votes; a processing receipt is NOT import completion. No trimming, silent drops, retries, or atomicity claim. JSON data.receipt is the per-row receipt; save it and read back before any retry."),
 "seed csv validate"|"seed csv preview" => c.arg(pos("csv",true)),
 "moderate list" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("status","Moderation state").value_parser(["all","pending","accepted","rejected"]).default_value("pending")).arg(arg("limit","Maximum rows returned").default_value("100").value_parser(clap::value_parser!(u16).range(1..=500))).arg(arg("offset","Rows to skip").default_value("0").value_parser(clap::value_parser!(u32).range(0..=2147483647))),
 "moderate accept"|"moderate reject" => c.arg(arg("conversation","Public conversation ID").required(true)).arg(arg("tid","Comment number in the conversation").required(true).value_parser(clap::value_parser!(u32).range(0..=2147483647))).after_help("Reads the current row before PUT; preserves is_meta, velocity and (for rejection) active. The legacy API has no compare-and-set: avoid concurrent edits of the same comment. No automatic retry."),
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
    let mut root=Command::new("polis").version(concat!(env!("CARGO_PKG_VERSION"), " (commit ", env!("POLIS_BUILD_COMMIT"), "; ", env!("POLIS_BUILD_SOURCE"), ")"))
 .about("Listen at scale. Bring Polis to your terminal.")
 .long_about("Listen at scale. Bring Polis to your terminal.\n\nConversations, comments, and shared understanding — for people and agents.\nWorking now: auth, conversations, seeds, moderation, participant/vote reads,
report exports, stored Delphi results, and raw API.\nThe full product surface is discoverable below; planned commands return exit 8.")
 .arg(flag("json","Emit the versioned polis-cli/1 JSON envelope (including errors and help)").global(true))
 .arg(flag("no-interactive","Never prompt; saved file sign-ins, explicitly opted-in Keychain and environment tokens still work").global(true))
 .arg(arg("timeout","Bound each HTTP request in seconds (1–300)").default_value("30").value_parser(clap::value_parser!(u64).range(1..=300)).global(true))
 .disable_help_subcommand(true).subcommand_required(true).arg_required_else_help(true);
    root = root.subcommand(Command::new("join")
        .about("Prepare anonymous participation or join with a Treevite code")
        .arg(pos("conversation", true))
        .arg(arg("invite", "Accept a one-time invite; save its login code privately").conflicts_with("login-code"))
        .arg(arg("login-code", "Sign in as a returning Treevite participant"))
        .after_help("Without a code, prepares participation without enrolling a fresh visitor. The first requested vote or comment enrolls them. Repeated joins reuse only this profile, origin and conversation's participant credentials. Invite and login codes are distinct; no automatic retry or fallback. Tokens and login codes are saved in the owner-only credentials store and never printed. Codes passed as arguments may be visible in local shell history and process listings."));
    for &(group, about, leaves) in GROUPS {
        let mut cmd = Command::new(group)
            .about(about)
            .subcommand_required(true)
            .arg_required_else_help(true);
        if group == "comment" {
            cmd = Command::new("comment")
        .about("Submit a participant comment, or read comments and their statistics")
        .subcommand_negates_reqs(true)
        .args_conflicts_with_subcommands(true)
        .arg(pos("conversation", true))
        .arg(pos("text", true))
        .after_help("EXAMPLES\n  polis comment CONVERSATION \"A comment to discuss\"\n  polis comment CONVERSATION \"A comment to discuss\" --json\n\nUses this profile, origin and conversation's participant credentials. In an open conversation the first requested comment enrolls an anonymous participant; no prior join or account sign-in is needed. For invitations, first use polis join CONVERSATION --invite CODE. Sends only conversation_id and txt, with no seed flag or author vote. Node enforces participation and moderation; a submission receipt does not imply approval or visibility. Text is never echoed in errors. Arguments can remain in shell history and process listings. No automatic retries; an uncertain write or credential-save failure exits 7. Inspect the conversation before submitting again.");
        }
        if group == "vote" {
            cmd = cmd.subcommand_required(false).arg_required_else_help(false)
                .args_conflicts_with_subcommands(true)
                .arg(pos("conversation", false))
                .arg(arg("statement", "Comment number (tid) to vote on once; the flag keeps its --statement name").value_parser(clap::value_parser!(u32).range(0..=2147483647)))
                .arg(flag("agree", "Agree with this comment").requires("statement").conflicts_with_all(["disagree", "pass"]))
                .arg(flag("disagree", "Disagree with this comment").requires("statement").conflicts_with("pass"))
                .arg(flag("pass", "Pass on this comment").requires("statement"))
                .arg(flag("important", "Mark this comment as important to you").requires("statement"))
                .after_help("EXAMPLES\n  polis vote CONVERSATION\n  polis vote CONVERSATION --statement 0 --agree --json\n  polis vote CONVERSATION --statement 0 --agree --important\n\nNo join or account sign-in is needed for anonymous voting in an open conversation. For invitations, first use polis join CONVERSATION --invite CODE. The first requested vote enrolls you; its participant token is saved privately for following votes, scoped by profile, origin and conversation. Account tokens are not used. The site enforces access and voting rules. Interactive voting requires a terminal; choose agree, disagree, pass, or quit. JSON and --no-interactive require --statement and exactly one choice. --important marks the comment as important to you, as the participation page's checkbox does; it does not change the choice. No automatic retry: an uncertain response or credential-save failure exits 7. Comment text is untrusted content. No server or vote policy is changed.");
        }
        if group == "conversation" {
            // `polis conversations list` is what people type first; it parses as the
            // canonical group, so command paths, schema and help are unchanged.
            cmd = cmd.visible_alias("conversations");
        }
        let mut nested: std::collections::BTreeMap<&str, Vec<&str>> =
            std::collections::BTreeMap::new();
        let mut declared = leaves
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        for o in crate::admin::operations() {
            if let Some(rest) = o.command.strip_prefix(&format!("{group} ")) {
                let key = rest.replace(' ', "/");
                if !declared.contains(&key) {
                    declared.push(key);
                }
            }
        }
        for op in &declared {
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
    root = root.subcommand(leaf("questions").after_help(crate::questions::text()));
    for name in ["browse", "tutorial"] {
        root = root.subcommand(leaf(name).arg(pos("target", false)));
    }
    root.after_help(format!("QUESTIONS ABOUT YOUR CONVERSATION\n  polis questions\n  Find shared ground, divisions, groups, importance, new comments, coverage, change, collective statements and participant comparisons.\n\nCONVERSATION RESERVATION\n  polis conversation reserve --json\n\nPARTICIPANT PREFERENCES\n  polis participant preferences --conversation <id> --translations true --json\n\nPARTICIPANT LOCATIONS\n  polis participant locations --conversation <id> --group 0 --json\n\nPARTICIPANT PROFILES\n  polis participant highlight list --conversation <id> --json\n\nSTORED MEMBERSHIP\n  polis participant group-members --conversation <id> --json\n\nSTORED MATH\n  polis math view --conversation <id> --key math_tick --key pca --json\n\nSTART HERE\n  polis auth login\n  polis auth status\n  polis conversation list --json\n  polis conversation create --topic 'Our next chapter'\n  polis seed import seeds.csv --conversation <id>\n\nMETADATA OPTIONS\n  polis metadata answer add --conversation <id> --question <id> --value 'Local resident' --yes\n\nMETADATA CLEANUP\n  polis metadata question delete --conversation <id> --question <id> --yes\n  polis metadata answer delete --conversation <id> --question <id> --answer <id> --yes\n\nSECOND PASS\n  polis moderate list --conversation <id> --status pending\n  polis moderate accept --conversation <id> --tid 0\n  polis moderate reject --conversation <id> --tid 0\n  polis participant status --conversation <id>\n  polis vote list --conversation <id> --pid 0\n  polis report view <report-id>\n  polis report export <report-id> --type votes.csv --output votes.csv\n  polis delphi status --report <report-id>\n  polis delphi results --report <report-id> --job <job-id>\n  polis plan view\n\nDISCOVER THE PRODUCT\n{}\n\nAGENT CONTRACT\n  --json --no-interactive   Stable output; no prompts or automatic retries\n  polis help <command>     Read a focused manual\n  polis schema             Discover commands and implementation status\n  POLIS_TOKEN              Token override; otherwise owner-only file (Keychain opt-in)\n  POLIS_CONFIG_DIR         Profile directory override (credentials/ holds saved sign-ins)\n  POLIS_KEYCHAIN           on opts into macOS Keychain; off is the default\n\nSign in to pol.is with polis auth login; no setup is required. Developer overrides use environment variables or profiles.json.\nQuota is reported as unavailable. Planned commands perform no action.",tree()))
}
pub fn tree() -> String {
    let mut lines = vec![
        "  join           CONVERSATION [--invite CODE | --login-code CODE]".into(),
        "  comment        CONVERSATION TEXT".into(),
        "  vote           CONVERSATION [--statement N --agree|--disagree|--pass [--important]]"
            .into(),
    ];
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
    lines.push("  Additional site operations (use help/schema for arguments):".into());
    for o in crate::admin::operations() {
        lines.push(format!("    {}", o.command));
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
