//! Storage rows; declarations and field provenance point to the reviewed migrations.
use super::*;

row! {
    ApikeysndvweifuRow, "apikeysndvweifu", "server/postgres/migrations/000000_initial.sql:128";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:129"),
    apikey: String => ("apikey", "varchar", false, "server/postgres/migrations/000000_initial.sql:130"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:131"),
}

row! {
    AuthTokensRow, "auth_tokens", "server/postgres/migrations/000000_initial.sql:105";
    token: Option<String> => ("token", "varchar", true, "server/postgres/migrations/000000_initial.sql:106"),
    uid: Option<i32> => ("uid", "int4", true, "server/postgres/migrations/000000_initial.sql:107"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:108"),
}

row! {
    BetaRow, "beta", "server/postgres/migrations/000000_initial.sql:303";
    name: Option<String> => ("name", "varchar", true, "server/postgres/migrations/000000_initial.sql:304"),
    email: Option<String> => ("email", "varchar", true, "server/postgres/migrations/000000_initial.sql:305"),
    organization: Option<String> => ("organization", "varchar", true, "server/postgres/migrations/000000_initial.sql:306"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:307"),
}

row! {
    ByodImportJobsRow, "byod_import_jobs", "server/postgres/migrations/000017_create_byod_job_table.sql:3";
    id: i32 => ("id", "int4", false, "server/postgres/migrations/000017_create_byod_job_table.sql:4"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000017_create_byod_job_table.sql:5"),
    s3_key: String => ("s3_key", "text", false, "server/postgres/migrations/000017_create_byod_job_table.sql:6"),
    status: Option<JobStatus> => ("status", "job_status", true, "server/postgres/migrations/000017_create_byod_job_table.sql:7"),
    stage: Option<String> => ("stage", "text", true, "server/postgres/migrations/000017_create_byod_job_table.sql:8"),
    error_message: Option<String> => ("error_message", "text", true, "server/postgres/migrations/000017_create_byod_job_table.sql:9"),
    created_at: Option<PgTimestamp> => ("created_at", "timestamptz", true, "server/postgres/migrations/000017_create_byod_job_table.sql:10"),
    updated_at: Option<PgTimestamp> => ("updated_at", "timestamptz", true, "server/postgres/migrations/000017_create_byod_job_table.sql:11"),
}

row! {
    CommentTranslationsRow, "comment_translations", "server/postgres/migrations/000000_initial.sql:570";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:571"),
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:572"),
    src: i32 => ("src", "int4", false, "server/postgres/migrations/000000_initial.sql:573"),
    txt: String => ("txt", "varchar", false, "server/postgres/migrations/000000_initial.sql:574"),
    lang: String => ("lang", "varchar", false, "server/postgres/migrations/000000_initial.sql:575"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:576"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:577"),
}

row! {
    CommentsRow, "comments", "server/postgres/migrations/000000_initial.sql:485";
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:486"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:487"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:488"),
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:489"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:490"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:491"),
    txt: String => ("txt", "varchar", false, "server/postgres/migrations/000000_initial.sql:492"),
    velocity: PgFloat4 => ("velocity", "float4", false, "server/postgres/migrations/000000_initial.sql:493"),
    r#mod: i32 => ("mod", "int4", false, "server/postgres/migrations/000000_initial.sql:494"),
    lang: Option<String> => ("lang", "varchar", true, "server/postgres/migrations/000000_initial.sql:495"),
    lang_confidence: Option<PgFloat4> => ("lang_confidence", "float4", true, "server/postgres/migrations/000000_initial.sql:496"),
    active: bool => ("active", "bool", false, "server/postgres/migrations/000000_initial.sql:497"),
    is_meta: bool => ("is_meta", "bool", false, "server/postgres/migrations/000000_initial.sql:498"),
    tweet_id: Option<i64> => ("tweet_id", "int8", true, "server/postgres/migrations/000000_initial.sql:499"),
    quote_src_url: Option<String> => ("quote_src_url", "varchar", true, "server/postgres/migrations/000000_initial.sql:500"),
    anon: bool => ("anon", "bool", false, "server/postgres/migrations/000000_initial.sql:501"),
    is_seed: bool => ("is_seed", "bool", false, "server/postgres/migrations/000000_initial.sql:502"),
    original_id: Option<PgUuid> => ("original_id", "uuid", true, "server/postgres/migrations/000016_add_orig_id.sql:2"),
}

row! {
    ContextsRow, "contexts", "server/postgres/migrations/000000_initial.sql:242";
    context_id: i32 => ("context_id", "int4", false, "server/postgres/migrations/000000_initial.sql:243"),
    name: Option<String> => ("name", "varchar", true, "server/postgres/migrations/000000_initial.sql:244"),
    creator: Option<i32> => ("creator", "int4", true, "server/postgres/migrations/000000_initial.sql:245"),
    is_public: Option<bool> => ("is_public", "bool", true, "server/postgres/migrations/000000_initial.sql:246"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:247"),
}

row! {
    ContributerAgreementSignaturesRow, "contributer_agreement_signatures", "server/postgres/migrations/000000_initial.sql:839";
    uid: Option<i32> => ("uid", "int4", true, "server/postgres/migrations/000000_initial.sql:840"),
    name: String => ("name", "varchar", false, "server/postgres/migrations/000000_initial.sql:841"),
    company_name: Option<String> => ("company_name", "varchar", true, "server/postgres/migrations/000000_initial.sql:842"),
    github_id: Option<String> => ("github_id", "varchar", true, "server/postgres/migrations/000000_initial.sql:843"),
    email: String => ("email", "varchar", false, "server/postgres/migrations/000000_initial.sql:844"),
    agreement_version: i32 => ("agreement_version", "int4", false, "server/postgres/migrations/000000_initial.sql:845"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:846"),
}

row! {
    ConversationTranslationsRow, "conversation_translations", "server/postgres/migrations/000000_initial.sql:583";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:584"),
    src: i32 => ("src", "int4", false, "server/postgres/migrations/000000_initial.sql:585"),
    topic: String => ("topic", "varchar", false, "server/postgres/migrations/000000_initial.sql:586"),
    description: String => ("description", "varchar", false, "server/postgres/migrations/000000_initial.sql:587"),
    lang: String => ("lang", "varchar", false, "server/postgres/migrations/000000_initial.sql:588"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:589"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:590"),
}

row! {
    ConversationsRow, "conversations", "server/postgres/migrations/000000_initial.sql:151";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:154"),
    topic: Option<String> => ("topic", "varchar", true, "server/postgres/migrations/000000_initial.sql:155"),
    description: Option<String> => ("description", "varchar", true, "server/postgres/migrations/000000_initial.sql:156"),
    link_url: Option<String> => ("link_url", "varchar", true, "server/postgres/migrations/000000_initial.sql:157"),
    parent_url: Option<String> => ("parent_url", "varchar", true, "server/postgres/migrations/000000_initial.sql:158"),
    upvotes: i32 => ("upvotes", "int4", false, "server/postgres/migrations/000000_initial.sql:159"),
    participant_count: Option<i32> => ("participant_count", "int4", true, "server/postgres/migrations/000000_initial.sql:160"),
    is_anon: Option<bool> => ("is_anon", "bool", true, "server/postgres/migrations/000000_initial.sql:161"),
    is_active: Option<bool> => ("is_active", "bool", true, "server/postgres/migrations/000000_initial.sql:162"),
    is_draft: Option<bool> => ("is_draft", "bool", true, "server/postgres/migrations/000000_initial.sql:163"),
    is_public: Option<bool> => ("is_public", "bool", true, "server/postgres/migrations/000000_initial.sql:164"),
    is_data_open: Option<bool> => ("is_data_open", "bool", true, "server/postgres/migrations/000000_initial.sql:165"),
    profanity_filter: Option<bool> => ("profanity_filter", "bool", true, "server/postgres/migrations/000000_initial.sql:166"),
    spam_filter: Option<bool> => ("spam_filter", "bool", true, "server/postgres/migrations/000000_initial.sql:167"),
    strict_moderation: Option<bool> => ("strict_moderation", "bool", true, "server/postgres/migrations/000000_initial.sql:168"),
    prioritize_seed: Option<bool> => ("prioritize_seed", "bool", true, "server/postgres/migrations/000000_initial.sql:169"),
    vis_type: i32 => ("vis_type", "int4", false, "server/postgres/migrations/000000_initial.sql:170"),
    write_type: i32 => ("write_type", "int4", false, "server/postgres/migrations/000000_initial.sql:171"),
    help_type: i32 => ("help_type", "int4", false, "server/postgres/migrations/000000_initial.sql:172"),
    write_hint_type: i32 => ("write_hint_type", "int4", false, "server/postgres/migrations/000000_initial.sql:173"),
    style_btn: Option<String> => ("style_btn", "varchar", true, "server/postgres/migrations/000000_initial.sql:174"),
    socialbtn_type: i32 => ("socialbtn_type", "int4", false, "server/postgres/migrations/000000_initial.sql:175"),
    subscribe_type: i32 => ("subscribe_type", "int4", false, "server/postgres/migrations/000000_initial.sql:176"),
    branding_type: i32 => ("branding_type", "int4", false, "server/postgres/migrations/000000_initial.sql:177"),
    bgcolor: Option<String> => ("bgcolor", "varchar", true, "server/postgres/migrations/000000_initial.sql:178"),
    help_bgcolor: Option<String> => ("help_bgcolor", "varchar", true, "server/postgres/migrations/000000_initial.sql:179"),
    help_color: Option<String> => ("help_color", "varchar", true, "server/postgres/migrations/000000_initial.sql:180"),
    email_domain: Option<String> => ("email_domain", "varchar", true, "server/postgres/migrations/000000_initial.sql:181"),
    use_xid_whitelist: Option<bool> => ("use_xid_whitelist", "bool", true, "server/postgres/migrations/000000_initial.sql:182"),
    owner: Option<i32> => ("owner", "int4", true, "server/postgres/migrations/000000_initial.sql:184"),
    org_id: Option<i32> => ("org_id", "int4", true, "server/postgres/migrations/000000_initial.sql:185"),
    context: Option<String> => ("context", "varchar", true, "server/postgres/migrations/000000_initial.sql:188"),
    course_id: Option<i32> => ("course_id", "int4", true, "server/postgres/migrations/000000_initial.sql:189"),
    owner_sees_participation_stats: Option<bool> => ("owner_sees_participation_stats", "bool", true, "server/postgres/migrations/000000_initial.sql:190"),
    auth_needed_to_vote: Option<bool> => ("auth_needed_to_vote", "bool", true, "server/postgres/migrations/000000_initial.sql:192"),
    auth_needed_to_write: Option<bool> => ("auth_needed_to_write", "bool", true, "server/postgres/migrations/000000_initial.sql:193"),
    auth_opt_fb: Option<bool> => ("auth_opt_fb", "bool", true, "server/postgres/migrations/000000_initial.sql:194"),
    auth_opt_tw: Option<bool> => ("auth_opt_tw", "bool", true, "server/postgres/migrations/000000_initial.sql:195"),
    auth_opt_allow_3rdparty: Option<bool> => ("auth_opt_allow_3rdparty", "bool", true, "server/postgres/migrations/000000_initial.sql:196"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:203"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:204"),
    importance_enabled: bool => ("importance_enabled", "bool", false, "server/postgres/migrations/000008_add_comment_priority.sql:2"),
    treevite_enabled: Option<bool> => ("treevite_enabled", "bool", true, "server/postgres/migrations/000013_create_treevite.sql:5"),
    xid_required: bool => ("xid_required", "bool", false, "server/postgres/migrations/000015_add_xid_requirements.sql:14"),
    topics_enabled: bool => ("topics_enabled", "bool", false, "server/postgres/migrations/000018_add_topics_enabled.sql:10"),
}

row! {
    CoursesRow, "courses", "server/postgres/migrations/000000_initial.sql:138";
    course_id: i32 => ("course_id", "int4", false, "server/postgres/migrations/000000_initial.sql:139"),
    topic: Option<String> => ("topic", "varchar", true, "server/postgres/migrations/000000_initial.sql:140"),
    description: Option<String> => ("description", "varchar", true, "server/postgres/migrations/000000_initial.sql:141"),
    owner: Option<i32> => ("owner", "int4", true, "server/postgres/migrations/000000_initial.sql:142"),
    course_invite: Option<String> => ("course_invite", "varchar", true, "server/postgres/migrations/000000_initial.sql:143"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:144"),
}

row! {
    CrowdModRow, "crowd_mod", "server/postgres/migrations/000000_initial.sql:803";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:804"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:805"),
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:806"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:807"),
    as_important: Option<bool> => ("as_important", "bool", true, "server/postgres/migrations/000000_initial.sql:810"),
    as_factual: Option<bool> => ("as_factual", "bool", true, "server/postgres/migrations/000000_initial.sql:811"),
    as_feeling: Option<bool> => ("as_feeling", "bool", true, "server/postgres/migrations/000000_initial.sql:812"),
    as_notmyfeeling: Option<bool> => ("as_notmyfeeling", "bool", true, "server/postgres/migrations/000000_initial.sql:815"),
    as_notgoodidea: Option<bool> => ("as_notgoodidea", "bool", true, "server/postgres/migrations/000000_initial.sql:816"),
    as_notfact: Option<bool> => ("as_notfact", "bool", true, "server/postgres/migrations/000000_initial.sql:817"),
    as_unsure: Option<bool> => ("as_unsure", "bool", true, "server/postgres/migrations/000000_initial.sql:821"),
    as_spam: Option<bool> => ("as_spam", "bool", true, "server/postgres/migrations/000000_initial.sql:822"),
    as_abusive: Option<bool> => ("as_abusive", "bool", true, "server/postgres/migrations/000000_initial.sql:823"),
    as_offtopic: Option<bool> => ("as_offtopic", "bool", true, "server/postgres/migrations/000000_initial.sql:824"),
}

row! {
    DemographicDataRow, "demographic_data", "server/postgres/migrations/000000_initial.sql:949";
    uid: Option<i32> => ("uid", "int4", true, "server/postgres/migrations/000000_initial.sql:950"),
    fb_gender: Option<i32> => ("fb_gender", "int4", true, "server/postgres/migrations/000000_initial.sql:951"),
    ms_birth_year_estimate_fb: Option<i32> => ("ms_birth_year_estimate_fb", "int4", true, "server/postgres/migrations/000000_initial.sql:952"),
    ms_gender_estimate_fb: Option<i32> => ("ms_gender_estimate_fb", "int4", true, "server/postgres/migrations/000000_initial.sql:953"),
    fb_timestamp: Option<i64> => ("fb_timestamp", "int8", true, "server/postgres/migrations/000000_initial.sql:954"),
    ms_fb_timestamp: Option<i64> => ("ms_fb_timestamp", "int8", true, "server/postgres/migrations/000000_initial.sql:955"),
    ms_response: Option<String> => ("ms_response", "varchar", true, "server/postgres/migrations/000000_initial.sql:956"),
    gender_guess: Option<i32> => ("gender_guess", "int4", true, "server/postgres/migrations/000000_initial.sql:957"),
    birth_year_guess: Option<i32> => ("birth_year_guess", "int4", true, "server/postgres/migrations/000000_initial.sql:958"),
}

row! {
    EinvitesRow, "einvites", "server/postgres/migrations/000000_initial.sql:273";
    einvite: String => ("einvite", "varchar", false, "server/postgres/migrations/000000_initial.sql:274"),
    email: Option<String> => ("email", "varchar", true, "server/postgres/migrations/000000_initial.sql:275"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:276"),
}

row! {
    EmailValidationsRow, "email_validations", "server/postgres/migrations/000000_initial.sql:280";
    email: Option<String> => ("email", "varchar", true, "server/postgres/migrations/000000_initial.sql:281"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:282"),
}

row! {
    EventPtptNoMoreCommentsRow, "event_ptpt_no_more_comments", "server/postgres/migrations/000000_initial.sql:831";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:832"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:833"),
    votes_placed: i16 => ("votes_placed", "int2", false, "server/postgres/migrations/000000_initial.sql:834"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:835"),
}

row! {
    FacebookFriendsRow, "facebook_friends", "server/postgres/migrations/000000_initial.sql:462";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:463"),
    friend: i32 => ("friend", "int4", false, "server/postgres/migrations/000000_initial.sql:464"),
}

row! {
    FacebookUsersRow, "facebook_users", "server/postgres/migrations/000000_initial.sql:429";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:430"),
    fb_user_id: Option<String> => ("fb_user_id", "text", true, "server/postgres/migrations/000000_initial.sql:431"),
    fb_name: Option<String> => ("fb_name", "varchar", true, "server/postgres/migrations/000000_initial.sql:432"),
    fb_link: Option<String> => ("fb_link", "varchar", true, "server/postgres/migrations/000000_initial.sql:433"),
    fb_public_profile: Option<String> => ("fb_public_profile", "text", true, "server/postgres/migrations/000000_initial.sql:434"),
    fb_login_status: Option<String> => ("fb_login_status", "text", true, "server/postgres/migrations/000000_initial.sql:435"),
    fb_auth_response: Option<String> => ("fb_auth_response", "text", true, "server/postgres/migrations/000000_initial.sql:436"),
    fb_access_token: Option<String> => ("fb_access_token", "text", true, "server/postgres/migrations/000000_initial.sql:437"),
    fb_granted_scopes: Option<String> => ("fb_granted_scopes", "text", true, "server/postgres/migrations/000000_initial.sql:438"),
    fb_location_id: Option<String> => ("fb_location_id", "varchar", true, "server/postgres/migrations/000000_initial.sql:439"),
    location: Option<String> => ("location", "varchar", true, "server/postgres/migrations/000000_initial.sql:440"),
    response: Option<String> => ("response", "text", true, "server/postgres/migrations/000000_initial.sql:441"),
    fb_friends_response: Option<String> => ("fb_friends_response", "text", true, "server/postgres/migrations/000000_initial.sql:442"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:443"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:444"),
}

row! {
    InvitersRow, "inviters", "server/postgres/migrations/000000_initial.sql:251";
    inviter_uid: Option<i32> => ("inviter_uid", "int4", true, "server/postgres/migrations/000000_initial.sql:252"),
    invited_email: Option<String> => ("invited_email", "varchar", true, "server/postgres/migrations/000000_initial.sql:253"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:254"),
}

row! {
    JianiuevyewRow, "jianiuevyew", "server/postgres/migrations/000000_initial.sql:117";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:118"),
    pwhash: String => ("pwhash", "varchar", false, "server/postgres/migrations/000000_initial.sql:119"),
}

row! {
    MathBidtopidRow, "math_bidtopid", "server/postgres/migrations/000000_initial.sql:698";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:699"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:700"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000000_initial.sql:701"),
    data: PgJson => ("data", "jsonb", false, "server/postgres/migrations/000000_initial.sql:702"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:703"),
}

row! {
    MathCacheRow, "math_cache", "server/postgres/migrations/000000_initial.sql:689";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:690"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:691"),
    data: PgJson => ("data", "jsonb", false, "server/postgres/migrations/000000_initial.sql:692"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:693"),
}

row! {
    MathExportstatusRow, "math_exportstatus", "server/postgres/migrations/000000_initial.sql:708";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:709"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:710"),
    filename: String => ("filename", "varchar", false, "server/postgres/migrations/000000_initial.sql:711"),
    data: PgJson => ("data", "jsonb", false, "server/postgres/migrations/000000_initial.sql:712"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:713"),
}

row! {
    MathMainRow, "math_main", "server/postgres/migrations/000000_initial.sql:658";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:659"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:660"),
    data: PgJson => ("data", "jsonb", false, "server/postgres/migrations/000000_initial.sql:661"),
    last_vote_timestamp: i64 => ("last_vote_timestamp", "int8", false, "server/postgres/migrations/000000_initial.sql:662"),
    caching_tick: i64 => ("caching_tick", "int8", false, "server/postgres/migrations/000000_initial.sql:663"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000000_initial.sql:664"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:665"),
}

row! {
    MathProfileRow, "math_profile", "server/postgres/migrations/000000_initial.sql:670";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:671"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:672"),
    data: PgJson => ("data", "jsonb", false, "server/postgres/migrations/000000_initial.sql:673"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:674"),
}

row! {
    MathPtptstatsRow, "math_ptptstats", "server/postgres/migrations/000000_initial.sql:679";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:680"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:681"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000000_initial.sql:682"),
    data: PgJson => ("data", "jsonb", false, "server/postgres/migrations/000000_initial.sql:683"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:684"),
}

row! {
    MathReportCorrelationmatrixRow, "math_report_correlationmatrix", "server/postgres/migrations/000000_initial.sql:718";
    rid: i64 => ("rid", "int8", false, "server/postgres/migrations/000000_initial.sql:719"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:720"),
    data: Option<PgJson> => ("data", "jsonb", true, "server/postgres/migrations/000000_initial.sql:721"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000000_initial.sql:722"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:723"),
}

row! {
    MathTicksRow, "math_ticks", "server/postgres/migrations/000000_initial.sql:647";
    zid: Option<i32> => ("zid", "int4", true, "server/postgres/migrations/000000_initial.sql:648"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000000_initial.sql:649"),
    caching_tick: i64 => ("caching_tick", "int8", false, "server/postgres/migrations/000000_initial.sql:650"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:651"),
    modified: i64 => ("modified", "int8", false, "server/postgres/migrations/000000_initial.sql:652"),
}

row! {
    MetricsRow, "metrics", "server/postgres/migrations/000000_initial.sql:97";
    uid: Option<i32> => ("uid", "int4", true, "server/postgres/migrations/000000_initial.sql:98"),
    r#type: i32 => ("type", "int4", false, "server/postgres/migrations/000000_initial.sql:99"),
    dur: Option<i32> => ("dur", "int4", true, "server/postgres/migrations/000000_initial.sql:100"),
    hashedpc: Option<i32> => ("hashedpc", "int4", true, "server/postgres/migrations/000000_initial.sql:101"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:102"),
}

row! {
    NotificationTasksRow, "notification_tasks", "server/postgres/migrations/000000_initial.sql:389";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:390"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:391"),
}

row! {
    OidcUserMappingsRow, "oidc_user_mappings", "server/postgres/migrations/000010_create_oidc_user_mappings.sql:4";
    oidc_sub: String => ("oidc_sub", "varchar", false, "server/postgres/migrations/000010_create_oidc_user_mappings.sql:5"),
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000010_create_oidc_user_mappings.sql:6"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000010_create_oidc_user_mappings.sql:7"),
}

row! {
    OinvitesRow, "oinvites", "server/postgres/migrations/000000_initial.sql:265";
    oinvite: String => ("oinvite", "varchar", false, "server/postgres/migrations/000000_initial.sql:266"),
    note: Option<String> => ("note", "varchar", true, "server/postgres/migrations/000000_initial.sql:267"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:268"),
}

row! {
    PageIdsRow, "page_ids", "server/postgres/migrations/000000_initial.sql:942";
    site_id: String => ("site_id", "varchar", false, "server/postgres/migrations/000000_initial.sql:943"),
    page_id: String => ("page_id", "varchar", false, "server/postgres/migrations/000000_initial.sql:944"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:945"),
}

row! {
    ParticipantLocationsRow, "participant_locations", "server/postgres/migrations/000000_initial.sql:353";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:354"),
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:355"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:356"),
    lat: PgFloat8 => ("lat", "float8", false, "server/postgres/migrations/000000_initial.sql:357"),
    lng: PgFloat8 => ("lng", "float8", false, "server/postgres/migrations/000000_initial.sql:358"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:359"),
    source: i32 => ("source", "int4", false, "server/postgres/migrations/000000_initial.sql:360"),
}

row! {
    ParticipantMetadataAnswersRow, "participant_metadata_answers", "server/postgres/migrations/000000_initial.sql:221";
    pmaid: i32 => ("pmaid", "int4", false, "server/postgres/migrations/000000_initial.sql:222"),
    pmqid: Option<i32> => ("pmqid", "int4", true, "server/postgres/migrations/000000_initial.sql:223"),
    zid: Option<i32> => ("zid", "int4", true, "server/postgres/migrations/000000_initial.sql:224"),
    value: Option<String> => ("value", "varchar", true, "server/postgres/migrations/000000_initial.sql:225"),
    alive: Option<bool> => ("alive", "bool", true, "server/postgres/migrations/000000_initial.sql:226"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:227"),
}

row! {
    ParticipantMetadataChoicesRow, "participant_metadata_choices", "server/postgres/migrations/000000_initial.sql:396";
    zid: Option<i32> => ("zid", "int4", true, "server/postgres/migrations/000000_initial.sql:397"),
    pid: Option<i32> => ("pid", "int4", true, "server/postgres/migrations/000000_initial.sql:398"),
    pmqid: Option<i32> => ("pmqid", "int4", true, "server/postgres/migrations/000000_initial.sql:399"),
    pmaid: Option<i32> => ("pmaid", "int4", true, "server/postgres/migrations/000000_initial.sql:400"),
    alive: Option<bool> => ("alive", "bool", true, "server/postgres/migrations/000000_initial.sql:401"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:402"),
}

row! {
    ParticipantMetadataQuestionsRow, "participant_metadata_questions", "server/postgres/migrations/000000_initial.sql:211";
    pmqid: i32 => ("pmqid", "int4", false, "server/postgres/migrations/000000_initial.sql:212"),
    zid: Option<i32> => ("zid", "int4", true, "server/postgres/migrations/000000_initial.sql:213"),
    key: Option<String> => ("key", "varchar", true, "server/postgres/migrations/000000_initial.sql:214"),
    alive: Option<bool> => ("alive", "bool", true, "server/postgres/migrations/000000_initial.sql:215"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:216"),
}

row! {
    ParticipantsRow, "participants", "server/postgres/migrations/000000_initial.sql:313";
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:314"),
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:315"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:316"),
    vote_count: i32 => ("vote_count", "int4", false, "server/postgres/migrations/000000_initial.sql:317"),
    last_interaction: i64 => ("last_interaction", "int8", false, "server/postgres/migrations/000000_initial.sql:319"),
    subscribed: i32 => ("subscribed", "int4", false, "server/postgres/migrations/000000_initial.sql:322"),
    last_notified: Option<i64> => ("last_notified", "int8", true, "server/postgres/migrations/000000_initial.sql:323"),
    nsli: i16 => ("nsli", "int2", false, "server/postgres/migrations/000000_initial.sql:324"),
    r#mod: i32 => ("mod", "int4", false, "server/postgres/migrations/000000_initial.sql:326"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:329"),
}

row! {
    ParticipantsExtendedRow, "participants_extended", "server/postgres/migrations/000000_initial.sql:338";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:339"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:340"),
    referrer: Option<String> => ("referrer", "varchar", true, "server/postgres/migrations/000000_initial.sql:341"),
    parent_url: Option<String> => ("parent_url", "varchar", true, "server/postgres/migrations/000000_initial.sql:342"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:343"),
    modified: i64 => ("modified", "int8", false, "server/postgres/migrations/000000_initial.sql:344"),
    subscribe_email: Option<String> => ("subscribe_email", "varchar", true, "server/postgres/migrations/000000_initial.sql:346"),
    show_translation_activated: Option<bool> => ("show_translation_activated", "bool", true, "server/postgres/migrations/000000_initial.sql:348"),
    permanent_cookie: Option<String> => ("permanent_cookie", "varchar", true, "server/postgres/migrations/000003_add_origin_permanent_cookie_columns.sql:2"),
    origin: Option<String> => ("origin", "varchar", true, "server/postgres/migrations/000003_add_origin_permanent_cookie_columns.sql:3"),
}

row! {
    PermanentcookiezidjoinsRow, "permanentcookiezidjoins", "server/postgres/migrations/000000_initial.sql:883";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:884"),
    cookie: Option<String> => ("cookie", "varchar", true, "server/postgres/migrations/000000_initial.sql:885"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:886"),
}

row! {
    PolisCoordinatorBudgetsRow, "polis_coordinator_budgets", "server/postgres/migrations/000021_create_polis_coordinator.sql:264";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:265"),
    max_operations: i32 => ("max_operations", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:266"),
    max_bytes: i64 => ("max_bytes", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:267"),
}

row! {
    PolisCoordinatorCursorsRow, "polis_coordinator_cursors", "server/postgres/migrations/000021_create_polis_coordinator.sql:219";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:220"),
    consumer: String => ("consumer", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:220"),
    position: PgJson => ("position", "jsonb", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:221"),
}

row! {
    PolisCoordinatorFailuresRow, "polis_coordinator_failures", "server/postgres/migrations/000021_create_polis_coordinator.sql:223";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:224"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:224"),
    attempts: i32 => ("attempts", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:225"),
    first_failed_at: PgTimestamp => ("first_failed_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:225"),
    next_attempt: PgTimestamp => ("next_attempt", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:226"),
}

row! {
    PolisCoordinatorFloorsRow, "polis_coordinator_floors", "server/postgres/migrations/000021_create_polis_coordinator.sql:296";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:297"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:297"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:298"),
    caching_tick: i64 => ("caching_tick", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:299"),
}

row! {
    PolisCoordinatorGenerationsRow, "polis_coordinator_generations", "server/postgres/migrations/000021_create_polis_coordinator.sql:239";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:240"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:240"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:241"),
    caching_tick: i64 => ("caching_tick", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:242"),
    owner_id: String => ("owner_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:243"),
    publisher_epoch: i64 => ("publisher_epoch", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:243"),
    operation_id: String => ("operation_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:244"),
    capability_sha256: String => ("capability_sha256", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:245"),
    expected_tick: Option<i64> => ("expected_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:246"),
    input_checkpoint: PgJson => ("input_checkpoint", "jsonb", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:248"),
    committed_at: PgTimestamp => ("committed_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:249"),
}

row! {
    PolisCoordinatorInstallRow, "polis_coordinator_install", "server/postgres/migrations/000021_create_polis_coordinator.sql:302";
    singleton: bool => ("singleton", "bool", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:303"),
    migration_id: String => ("migration_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:303"),
    catalog_fingerprint: String => ("catalog_fingerprint", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:304"),
    provenance_fingerprint: String => ("provenance_fingerprint", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:305"),
    sequence_start: i64 => ("sequence_start", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:306"),
    installed_at: PgTimestamp => ("installed_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:307"),
    installed_by: String => ("installed_by", "name", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:307"),
}

row! {
    PolisCoordinatorInstallGrantsRow, "polis_coordinator_install_grants", "server/postgres/migrations/000021_create_polis_coordinator.sql:313";
    object_kind: String => ("object_kind", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:314"),
    object_name: String => ("object_name", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:315"),
    column_name: String => ("column_name", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:315"),
    grantee: String => ("grantee", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:315"),
    grantor: String => ("grantor", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:315"),
    privilege: String => ("privilege", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:316"),
    prior_present: bool => ("prior_present", "bool", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:317"),
    prior_grantable: bool => ("prior_grantable", "bool", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:317"),
}

row! {
    PolisCoordinatorInstallRolesRow, "polis_coordinator_install_roles", "server/postgres/migrations/000021_create_polis_coordinator.sql:309";
    role_name: String => ("role_name", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:310"),
    role_oid: u32 => ("role_oid", "oid", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:311"),
    created: bool => ("created", "bool", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:311"),
}

row! {
    PolisCoordinatorLeasesRow, "polis_coordinator_leases", "server/postgres/migrations/000021_create_polis_coordinator.sql:205";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:206"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:206"),
    owner_id: String => ("owner_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:207"),
    owner_epoch: i64 => ("owner_epoch", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:208"),
    expires_at: PgTimestamp => ("expires_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:208"),
    dispatch_operation_id: Option<String> => ("dispatch_operation_id", "text", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:209"),
    dispatch_capability_sha256: Option<String> => ("dispatch_capability_sha256", "text", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:209"),
    dispatch_checkpoint_sha256: Option<String> => ("dispatch_checkpoint_sha256", "text", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:209"),
    dispatch_expected_tick: Option<i64> => ("dispatch_expected_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:210"),
    dispatch_margin_ms: Option<i32> => ("dispatch_margin_ms", "int4", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:210"),
}

row! {
    PolisCoordinatorNamespacesRow, "polis_coordinator_namespaces", "server/postgres/migrations/000021_create_polis_coordinator.sql:170";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:171"),
    writer_kind: String => ("writer_kind", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:172"),
    max_transitions: i32 => ("max_transitions", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:173"),
}

row! {
    PolisCoordinatorOperationsRow, "polis_coordinator_operations", "server/postgres/migrations/000021_create_polis_coordinator.sql:269";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:270"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:271"),
    operation_id: String => ("operation_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:272"),
    owner_id: String => ("owner_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:273"),
    owner_epoch: i64 => ("owner_epoch", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:274"),
    expected_tick: Option<i64> => ("expected_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:275"),
    capability_sha256: String => ("capability_sha256", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:276"),
    checkpoint_sha256: String => ("checkpoint_sha256", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:277"),
    source_sha256: String => ("source_sha256", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:278"),
    reserved_bytes: i64 => ("reserved_bytes", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:279"),
    state: String => ("state", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:280"),
    protected: bool => ("protected", "bool", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:281"),
    admitted_at: PgTimestamp => ("admitted_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:282"),
    reconciled_at: PgTimestamp => ("reconciled_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:283"),
    resolved_tick: Option<i64> => ("resolved_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:284"),
}

row! {
    PolisCoordinatorPayloadsRow, "polis_coordinator_payloads", "server/postgres/migrations/000021_create_polis_coordinator.sql:252";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:253"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:253"),
    math_tick: i64 => ("math_tick", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:253"),
    payload_kind: String => ("payload_kind", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:254"),
    original_bytes: Vec<u8> => ("original_bytes", "bytea", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:255"),
    original_sha256: String => ("original_sha256", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:256"),
    storage_sha256: String => ("storage_sha256", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:257"),
}

row! {
    PolisCoordinatorPrincipalsRow, "polis_coordinator_principals", "server/postgres/migrations/000021_create_polis_coordinator.sql:181";
    principal_oid: u32 => ("principal_oid", "oid", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:182"),
    principal_name: String => ("principal_name", "name", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:182"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:183"),
    can_transition: bool => ("can_transition", "bool", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:184"),
}

row! {
    PolisCoordinatorReconciliationRow, "polis_coordinator_reconciliation", "server/postgres/migrations/000021_create_polis_coordinator.sql:229";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:230"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:230"),
    reconciled_at: PgTimestamp => ("reconciled_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:231"),
    source_probe: PgJson => ("source_probe", "jsonb", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:231"),
}

row! {
    PolisCoordinatorReferencesRow, "polis_coordinator_references", "server/postgres/migrations/000021_create_polis_coordinator.sql:290";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:291"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:291"),
    operation_id: String => ("operation_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:291"),
    reference_name: String => ("reference_name", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:292"),
}

row! {
    PolisCoordinatorTransitionsRow, "polis_coordinator_transitions", "server/postgres/migrations/000021_create_polis_coordinator.sql:186";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:187"),
    transition_id: String => ("transition_id", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:188"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:189"),
    source_env: String => ("source_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:190"),
    principal_oid: u32 => ("principal_oid", "oid", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:191"),
    principal_name: String => ("principal_name", "name", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:191"),
    last_served_tick: Option<i64> => ("last_served_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:192"),
    source_tick: Option<i64> => ("source_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:193"),
    destination_tick: Option<i64> => ("destination_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:194"),
    floor_tick: i64 => ("floor_tick", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:195"),
    result_tick: Option<i64> => ("result_tick", "int8", true, "server/postgres/migrations/000021_create_polis_coordinator.sql:196"),
    caching_tick: i64 => ("caching_tick", "int8", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:197"),
    writer_kind: String => ("writer_kind", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:198"),
    exclusion_sha256: String => ("exclusion_sha256", "text", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:200"),
    committed_at: PgTimestamp => ("committed_at", "timestamptz", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:201"),
}

row! {
    PolisCoordinatorWriterAuthorityRow, "polis_coordinator_writer_authority", "server/postgres/migrations/000021_create_polis_coordinator.sql:175";
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:176"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:177"),
    enabled: bool => ("enabled", "bool", false, "server/postgres/migrations/000021_create_polis_coordinator.sql:178"),
}

row! {
    PolisQueueAttemptsRow, "polis_queue_attempts", "server/postgres/migrations/000019_create_polis_queue.sql:299";
    env: String => ("env", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:300"),
    attempt_id: PgUuid => ("attempt_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:300"),
    job_id: PgUuid => ("job_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:300"),
    owner_id: PgUuid => ("owner_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:300"),
    lease_epoch: i64 => ("lease_epoch", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:301"),
    started_at: PgTimestamp => ("started_at", "timestamptz", false, "server/postgres/migrations/000019_create_polis_queue.sql:301"),
    ended_at: Option<PgTimestamp> => ("ended_at", "timestamptz", true, "server/postgres/migrations/000019_create_polis_queue.sql:301"),
    outcome: String => ("outcome", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:302"),
    error_code: Option<String> => ("error_code", "text", true, "server/postgres/migrations/000019_create_polis_queue.sql:303"),
    output_sha256: Option<String> => ("output_sha256", "text", true, "server/postgres/migrations/000019_create_polis_queue.sql:303"),
}

row! {
    PolisQueueHeadsRow, "polis_queue_heads", "server/postgres/migrations/000019_create_polis_queue.sql:266";
    env: String => ("env", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:267"),
    product_key: String => ("product_key", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:267"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000019_create_polis_queue.sql:267"),
    requested_generation: i64 => ("requested_generation", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:268"),
    desired_run_id: Option<PgUuid> => ("desired_run_id", "uuid", true, "server/postgres/migrations/000019_create_polis_queue.sql:269"),
    published_run_id: Option<PgUuid> => ("published_run_id", "uuid", true, "server/postgres/migrations/000019_create_polis_queue.sql:269"),
    published_generation: i64 => ("published_generation", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:269"),
    published_sha256: Option<String> => ("published_sha256", "text", true, "server/postgres/migrations/000019_create_polis_queue.sql:270"),
    version: i64 => ("version", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:270"),
}

row! {
    PolisQueueInstallRow, "polis_queue_install", "server/postgres/migrations/000019_create_polis_queue.sql:332";
    singleton: bool => ("singleton", "bool", false, "server/postgres/migrations/000019_create_polis_queue.sql:333"),
    created_roles: Vec<Option<String>> => ("created_roles", "_text", false, "server/postgres/migrations/000019_create_polis_queue.sql:334"),
    adopted_roles: Vec<Option<String>> => ("adopted_roles", "_text", false, "server/postgres/migrations/000019_create_polis_queue.sql:335"),
    added_grants: PgJson => ("added_grants", "jsonb", false, "server/postgres/migrations/000019_create_polis_queue.sql:336"),
    applied_at: PgTimestamp => ("applied_at", "timestamptz", false, "server/postgres/migrations/000019_create_polis_queue.sql:337"),
    catalog_fingerprint: String => ("catalog_fingerprint", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:338"),
}

row! {
    PolisQueueJobsRow, "polis_queue_jobs", "server/postgres/migrations/000019_create_polis_queue.sql:280";
    env: String => ("env", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:281"),
    job_id: PgUuid => ("job_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:281"),
    run_id: PgUuid => ("run_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:281"),
    stage: String => ("stage", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:282"),
    stage_instance: Option<String> => ("stage_instance", "text", true, "server/postgres/migrations/000019_create_polis_queue.sql:282"),
    state: String => ("state", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:283"),
    priority: i16 => ("priority", "int2", false, "server/postgres/migrations/000019_create_polis_queue.sql:284"),
    eligible_at: PgTimestamp => ("eligible_at", "timestamptz", false, "server/postgres/migrations/000019_create_polis_queue.sql:284"),
    created_at: PgTimestamp => ("created_at", "timestamptz", false, "server/postgres/migrations/000019_create_polis_queue.sql:285"),
    updated_at: PgTimestamp => ("updated_at", "timestamptz", false, "server/postgres/migrations/000019_create_polis_queue.sql:285"),
    attempt_count: i32 => ("attempt_count", "int4", false, "server/postgres/migrations/000019_create_polis_queue.sql:286"),
    parked_attempt_count: i32 => ("parked_attempt_count", "int4", false, "server/postgres/migrations/000019_create_polis_queue.sql:287"),
    max_attempts: i32 => ("max_attempts", "int4", false, "server/postgres/migrations/000019_create_polis_queue.sql:287"),
    lease_epoch: i64 => ("lease_epoch", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:288"),
    version: i64 => ("version", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:288"),
    mgmt_version: i64 => ("mgmt_version", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:289"),
    owner_id: Option<PgUuid> => ("owner_id", "uuid", true, "server/postgres/migrations/000019_create_polis_queue.sql:290"),
    attempt_id: Option<PgUuid> => ("attempt_id", "uuid", true, "server/postgres/migrations/000019_create_polis_queue.sql:290"),
    locked_until: Option<PgTimestamp> => ("locked_until", "timestamptz", true, "server/postgres/migrations/000019_create_polis_queue.sql:290"),
    terminal_attempt_id: Option<PgUuid> => ("terminal_attempt_id", "uuid", true, "server/postgres/migrations/000019_create_polis_queue.sql:290"),
    first_parked_at: Option<PgTimestamp> => ("first_parked_at", "timestamptz", true, "server/postgres/migrations/000019_create_polis_queue.sql:291"),
    last_error_code: Option<String> => ("last_error_code", "text", true, "server/postgres/migrations/000019_create_polis_queue.sql:292"),
    output_sha256: Option<String> => ("output_sha256", "text", true, "server/postgres/migrations/000019_create_polis_queue.sql:292"),
}

row! {
    PolisQueueRequestsRow, "polis_queue_requests", "server/postgres/migrations/000019_create_polis_queue.sql:307";
    env: String => ("env", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:308"),
    actor_scope: String => ("actor_scope", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:308"),
    product_key: String => ("product_key", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:308"),
    request_key: String => ("request_key", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:308"),
    request_sha256: String => ("request_sha256", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:309"),
    run_id: PgUuid => ("run_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:310"),
    job_id: PgUuid => ("job_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:310"),
    created_at: PgTimestamp => ("created_at", "timestamptz", false, "server/postgres/migrations/000019_create_polis_queue.sql:310"),
}

row! {
    PolisQueueRunsRow, "polis_queue_runs", "server/postgres/migrations/000019_create_polis_queue.sql:250";
    env: String => ("env", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:251"),
    run_id: PgUuid => ("run_id", "uuid", false, "server/postgres/migrations/000019_create_polis_queue.sql:251"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000019_create_polis_queue.sql:252"),
    product_key: String => ("product_key", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:253"),
    requested_generation: i64 => ("requested_generation", "int8", false, "server/postgres/migrations/000019_create_polis_queue.sql:253"),
    input_uri: String => ("input_uri", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:254"),
    input_sha256: String => ("input_sha256", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:255"),
    expected_output_uri: String => ("expected_output_uri", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:256"),
    expected_output_sha256: String => ("expected_output_sha256", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:257"),
    config_sha256: String => ("config_sha256", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:258"),
    code_image_digest: String => ("code_image_digest", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:259"),
    contract_version: String => ("contract_version", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:259"),
    state: String => ("state", "text", false, "server/postgres/migrations/000019_create_polis_queue.sql:260"),
    output_sha256: Option<String> => ("output_sha256", "text", true, "server/postgres/migrations/000019_create_polis_queue.sql:261"),
    created_at: PgTimestamp => ("created_at", "timestamptz", false, "server/postgres/migrations/000019_create_polis_queue.sql:261"),
}

row! {
    PwresetTokensRow, "pwreset_tokens", "server/postgres/migrations/000000_initial.sql:296";
    uid: Option<i32> => ("uid", "int4", true, "server/postgres/migrations/000000_initial.sql:297"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:298"),
    token: Option<String> => ("token", "varchar", true, "server/postgres/migrations/000000_initial.sql:299"),
}

row! {
    ReportCommentSelectionsRow, "report_comment_selections", "server/postgres/migrations/000000_initial.sql:625";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:626"),
    rid: i64 => ("rid", "int8", false, "server/postgres/migrations/000000_initial.sql:627"),
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:628"),
    selection: i16 => ("selection", "int2", false, "server/postgres/migrations/000000_initial.sql:629"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:630"),
}

row! {
    ReportsRow, "reports", "server/postgres/migrations/000000_initial.sql:596";
    rid: i64 => ("rid", "int8", false, "server/postgres/migrations/000000_initial.sql:597"),
    report_id: String => ("report_id", "varchar", false, "server/postgres/migrations/000000_initial.sql:598"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:599"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:600"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:601"),
    report_name: Option<String> => ("report_name", "varchar", true, "server/postgres/migrations/000000_initial.sql:603"),
    label_x_neg: Option<String> => ("label_x_neg", "varchar", true, "server/postgres/migrations/000000_initial.sql:605"),
    label_x_pos: Option<String> => ("label_x_pos", "varchar", true, "server/postgres/migrations/000000_initial.sql:606"),
    label_y_neg: Option<String> => ("label_y_neg", "varchar", true, "server/postgres/migrations/000000_initial.sql:607"),
    label_y_pos: Option<String> => ("label_y_pos", "varchar", true, "server/postgres/migrations/000000_initial.sql:608"),
    label_group_0: Option<String> => ("label_group_0", "varchar", true, "server/postgres/migrations/000000_initial.sql:610"),
    label_group_1: Option<String> => ("label_group_1", "varchar", true, "server/postgres/migrations/000000_initial.sql:611"),
    label_group_2: Option<String> => ("label_group_2", "varchar", true, "server/postgres/migrations/000000_initial.sql:612"),
    label_group_3: Option<String> => ("label_group_3", "varchar", true, "server/postgres/migrations/000000_initial.sql:613"),
    label_group_4: Option<String> => ("label_group_4", "varchar", true, "server/postgres/migrations/000000_initial.sql:614"),
    label_group_5: Option<String> => ("label_group_5", "varchar", true, "server/postgres/migrations/000000_initial.sql:615"),
    label_group_6: Option<String> => ("label_group_6", "varchar", true, "server/postgres/migrations/000000_initial.sql:616"),
    label_group_7: Option<String> => ("label_group_7", "varchar", true, "server/postgres/migrations/000000_initial.sql:617"),
    label_group_8: Option<String> => ("label_group_8", "varchar", true, "server/postgres/migrations/000000_initial.sql:618"),
    label_group_9: Option<String> => ("label_group_9", "varchar", true, "server/postgres/migrations/000000_initial.sql:619"),
    mod_level: i16 => ("mod_level", "int2", false, "server/postgres/migrations/000014_alter_reports_modlevel.sql:2"),
}

row! {
    SiteDomainWhitelistRow, "site_domain_whitelist", "server/postgres/migrations/000000_initial.sql:86";
    site_id: String => ("site_id", "varchar", false, "server/postgres/migrations/000000_initial.sql:87"),
    domain_whitelist: Option<String> => ("domain_whitelist", "varchar", true, "server/postgres/migrations/000000_initial.sql:88"),
    domain_whitelist_override_key: Option<String> => ("domain_whitelist_override_key", "varchar", true, "server/postgres/migrations/000000_initial.sql:89"),
    modified: i64 => ("modified", "int8", false, "server/postgres/migrations/000000_initial.sql:90"),
    created: i64 => ("created", "int8", false, "server/postgres/migrations/000000_initial.sql:91"),
}

row! {
    SocialSettingsRow, "social_settings", "server/postgres/migrations/000000_initial.sql:449";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:450"),
    polis_pic: Option<String> => ("polis_pic", "varchar", true, "server/postgres/migrations/000000_initial.sql:451"),
}

row! {
    StarsRow, "stars", "server/postgres/migrations/000000_initial.sql:863";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:864"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:865"),
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:866"),
    starred: i32 => ("starred", "int4", false, "server/postgres/migrations/000000_initial.sql:867"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:868"),
}

row! {
    SuzinvitesRow, "suzinvites", "server/postgres/migrations/000000_initial.sql:471";
    owner: i32 => ("owner", "int4", false, "server/postgres/migrations/000000_initial.sql:472"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:473"),
    xid: String => ("xid", "text", false, "server/postgres/migrations/000000_initial.sql:474"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:475"),
    suzinvite: Option<String> => ("suzinvite", "varchar", true, "server/postgres/migrations/000000_initial.sql:476"),
}

row! {
    TopicAgendaSelectionsRow, "topic_agenda_selections", "server/postgres/migrations/000012_create_topic_agenda_selections.sql:4";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000012_create_topic_agenda_selections.sql:6"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000012_create_topic_agenda_selections.sql:7"),
    archetypal_selections: PgJson => ("archetypal_selections", "jsonb", false, "server/postgres/migrations/000012_create_topic_agenda_selections.sql:10"),
    delphi_job_id: Option<String> => ("delphi_job_id", "text", true, "server/postgres/migrations/000012_create_topic_agenda_selections.sql:13"),
    total_selections: i32 => ("total_selections", "int4", false, "server/postgres/migrations/000012_create_topic_agenda_selections.sql:14"),
    created_at: Option<PgTimestamp> => ("created_at", "timestamptz", true, "server/postgres/migrations/000012_create_topic_agenda_selections.sql:17"),
    updated_at: Option<PgTimestamp> => ("updated_at", "timestamptz", true, "server/postgres/migrations/000012_create_topic_agenda_selections.sql:18"),
}

row! {
    TrashesRow, "trashes", "server/postgres/migrations/000000_initial.sql:873";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:874"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:875"),
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:876"),
    trashed: i32 => ("trashed", "int4", false, "server/postgres/migrations/000000_initial.sql:877"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:878"),
}

row! {
    TreeviteInvitesRow, "treevite_invites", "server/postgres/migrations/000013_create_treevite.sql:46";
    id: i64 => ("id", "int8", false, "server/postgres/migrations/000013_create_treevite.sql:47"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000013_create_treevite.sql:48"),
    wave_id: i64 => ("wave_id", "int8", false, "server/postgres/migrations/000013_create_treevite.sql:49"),
    parent_invite_id: Option<i64> => ("parent_invite_id", "int8", true, "server/postgres/migrations/000013_create_treevite.sql:50"),
    invite_code: String => ("invite_code", "varchar", false, "server/postgres/migrations/000013_create_treevite.sql:53"),
    status: i16 => ("status", "int2", false, "server/postgres/migrations/000013_create_treevite.sql:54"),
    invite_owner_pid: Option<i32> => ("invite_owner_pid", "int4", true, "server/postgres/migrations/000013_create_treevite.sql:56"),
    invite_used_by_pid: Option<i32> => ("invite_used_by_pid", "int4", true, "server/postgres/migrations/000013_create_treevite.sql:57"),
    invite_used_at: Option<PgTimestamp> => ("invite_used_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:58"),
    created_at: Option<PgTimestamp> => ("created_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:60"),
    updated_at: Option<PgTimestamp> => ("updated_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:61"),
}

row! {
    TreeviteLoginCodesRow, "treevite_login_codes", "server/postgres/migrations/000013_create_treevite.sql:95";
    id: i64 => ("id", "int8", false, "server/postgres/migrations/000013_create_treevite.sql:96"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000013_create_treevite.sql:97"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000013_create_treevite.sql:98"),
    login_code_hash: String => ("login_code_hash", "text", false, "server/postgres/migrations/000013_create_treevite.sql:101"),
    login_code_fingerprint: String => ("login_code_fingerprint", "varchar", false, "server/postgres/migrations/000013_create_treevite.sql:104"),
    login_code_lookup: Option<String> => ("login_code_lookup", "varchar", true, "server/postgres/migrations/000013_create_treevite.sql:106"),
    fp_kid: i16 => ("fp_kid", "int2", false, "server/postgres/migrations/000013_create_treevite.sql:107"),
    revoked: bool => ("revoked", "bool", false, "server/postgres/migrations/000013_create_treevite.sql:109"),
    expires_at: Option<PgTimestamp> => ("expires_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:110"),
    last_used_at: Option<PgTimestamp> => ("last_used_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:111"),
    created_at: Option<PgTimestamp> => ("created_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:112"),
    updated_at: Option<PgTimestamp> => ("updated_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:113"),
}

row! {
    TreeviteWavesRow, "treevite_waves", "server/postgres/migrations/000013_create_treevite.sql:10";
    id: i64 => ("id", "int8", false, "server/postgres/migrations/000013_create_treevite.sql:11"),
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000013_create_treevite.sql:12"),
    wave: i32 => ("wave", "int4", false, "server/postgres/migrations/000013_create_treevite.sql:13"),
    parent_wave: Option<i32> => ("parent_wave", "int4", true, "server/postgres/migrations/000013_create_treevite.sql:14"),
    size: Option<i32> => ("size", "int4", true, "server/postgres/migrations/000013_create_treevite.sql:16"),
    invites_per_user: i32 => ("invites_per_user", "int4", false, "server/postgres/migrations/000013_create_treevite.sql:17"),
    owner_invites: i32 => ("owner_invites", "int4", false, "server/postgres/migrations/000013_create_treevite.sql:18"),
    created_at: Option<PgTimestamp> => ("created_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:19"),
    updated_at: Option<PgTimestamp> => ("updated_at", "timestamptz", true, "server/postgres/migrations/000013_create_treevite.sql:20"),
}

row! {
    TwitterUsersRow, "twitter_users", "server/postgres/migrations/000000_initial.sql:408";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:409"),
    twitter_user_id: i64 => ("twitter_user_id", "int8", false, "server/postgres/migrations/000000_initial.sql:410"),
    screen_name: String => ("screen_name", "varchar", false, "server/postgres/migrations/000000_initial.sql:415"),
    name: Option<String> => ("name", "varchar", true, "server/postgres/migrations/000000_initial.sql:416"),
    followers_count: i32 => ("followers_count", "int4", false, "server/postgres/migrations/000000_initial.sql:417"),
    friends_count: i32 => ("friends_count", "int4", false, "server/postgres/migrations/000000_initial.sql:418"),
    verified: bool => ("verified", "bool", false, "server/postgres/migrations/000000_initial.sql:419"),
    profile_image_url_https: Option<String> => ("profile_image_url_https", "varchar", true, "server/postgres/migrations/000000_initial.sql:420"),
    location: Option<String> => ("location", "varchar", true, "server/postgres/migrations/000000_initial.sql:421"),
    response: Option<PgJson> => ("response", "json", true, "server/postgres/migrations/000000_initial.sql:422"),
    modified: i64 => ("modified", "int8", false, "server/postgres/migrations/000000_initial.sql:423"),
    created: i64 => ("created", "int8", false, "server/postgres/migrations/000000_initial.sql:424"),
}

row! {
    UpvotesRow, "upvotes", "server/postgres/migrations/000000_initial.sql:257";
    uid: Option<i32> => ("uid", "int4", true, "server/postgres/migrations/000000_initial.sql:258"),
    zid: Option<i32> => ("zid", "int4", true, "server/postgres/migrations/000000_initial.sql:259"),
}

row! {
    UsersRow, "users", "server/postgres/migrations/000000_initial.sql:64";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:67"),
    hname: Option<String> => ("hname", "varchar", true, "server/postgres/migrations/000000_initial.sql:68"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:69"),
    username: Option<String> => ("username", "varchar", true, "server/postgres/migrations/000000_initial.sql:70"),
    email: Option<String> => ("email", "varchar", true, "server/postgres/migrations/000000_initial.sql:71"),
    is_owner: Option<bool> => ("is_owner", "bool", true, "server/postgres/migrations/000000_initial.sql:72"),
    zinvite: Option<String> => ("zinvite", "varchar", true, "server/postgres/migrations/000000_initial.sql:73"),
    oinvite: Option<String> => ("oinvite", "varchar", true, "server/postgres/migrations/000000_initial.sql:74"),
    tut: Option<i16> => ("tut", "int2", true, "server/postgres/migrations/000000_initial.sql:75"),
    site_id: String => ("site_id", "varchar", false, "server/postgres/migrations/000000_initial.sql:76"),
    site_owner: Option<bool> => ("site_owner", "bool", true, "server/postgres/migrations/000000_initial.sql:77"),
}

row! {
    VotesRow, "votes", "server/postgres/migrations/000000_initial.sql:737";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:738"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:739"),
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:740"),
    vote: Option<i16> => ("vote", "int2", true, "server/postgres/migrations/000000_initial.sql:747"),
    weight_x_32767: Option<i16> => ("weight_x_32767", "int2", true, "server/postgres/migrations/000000_initial.sql:752"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:754"),
    high_priority: bool => ("high_priority", "bool", false, "server/postgres/migrations/000008_add_comment_priority.sql:6"),
}

row! {
    VotesLatestUniqueRow, "votes_latest_unique", "server/postgres/migrations/000000_initial.sql:772";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:773"),
    pid: i32 => ("pid", "int4", false, "server/postgres/migrations/000000_initial.sql:774"),
    tid: i32 => ("tid", "int4", false, "server/postgres/migrations/000000_initial.sql:775"),
    vote: Option<i16> => ("vote", "int2", true, "server/postgres/migrations/000000_initial.sql:782"),
    weight_x_32767: Option<i16> => ("weight_x_32767", "int2", true, "server/postgres/migrations/000000_initial.sql:787"),
    modified: Option<i64> => ("modified", "int8", true, "server/postgres/migrations/000000_initial.sql:789"),
}

row! {
    WorkerTasksRow, "worker_tasks", "server/postgres/migrations/000000_initial.sql:635";
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:636"),
    math_env: String => ("math_env", "varchar", false, "server/postgres/migrations/000000_initial.sql:637"),
    attempts: i16 => ("attempts", "int2", false, "server/postgres/migrations/000000_initial.sql:638"),
    task_data: PgJson => ("task_data", "jsonb", false, "server/postgres/migrations/000000_initial.sql:639"),
    task_type: Option<String> => ("task_type", "varchar", true, "server/postgres/migrations/000000_initial.sql:640"),
    task_bucket: Option<i64> => ("task_bucket", "int8", true, "server/postgres/migrations/000000_initial.sql:641"),
    finished_time: Option<i64> => ("finished_time", "int8", true, "server/postgres/migrations/000000_initial.sql:642"),
}

row! {
    XidWhitelistRow, "xid_whitelist", "server/postgres/migrations/000000_initial.sql:380";
    owner: i32 => ("owner", "int4", false, "server/postgres/migrations/000000_initial.sql:381"),
    xid: String => ("xid", "text", false, "server/postgres/migrations/000000_initial.sql:382"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:383"),
    zid: Option<i32> => ("zid", "int4", true, "server/postgres/migrations/000015_add_xid_requirements.sql:23"),
}

row! {
    XidsRow, "xids", "server/postgres/migrations/000000_initial.sql:366";
    uid: i32 => ("uid", "int4", false, "server/postgres/migrations/000000_initial.sql:367"),
    owner: i32 => ("owner", "int4", false, "server/postgres/migrations/000000_initial.sql:368"),
    xid: String => ("xid", "text", false, "server/postgres/migrations/000000_initial.sql:369"),
    x_profile_image_url: Option<String> => ("x_profile_image_url", "varchar", true, "server/postgres/migrations/000000_initial.sql:370"),
    x_name: Option<String> => ("x_name", "varchar", true, "server/postgres/migrations/000000_initial.sql:371"),
    x_email: Option<String> => ("x_email", "varchar", true, "server/postgres/migrations/000000_initial.sql:372"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:373"),
    modified: i64 => ("modified", "int8", false, "server/postgres/migrations/000000_initial.sql:374"),
    zid: Option<i32> => ("zid", "int4", true, "server/postgres/migrations/000015_add_xid_requirements.sql:43"),
    pid: Option<i32> => ("pid", "int4", true, "server/postgres/migrations/000015_add_xid_requirements.sql:51"),
}

row! {
    ZinvitesRow, "zinvites", "server/postgres/migrations/000000_initial.sql:287";
    zid: i32 => ("zid", "int4", false, "server/postgres/migrations/000000_initial.sql:288"),
    zinvite: String => ("zinvite", "varchar", false, "server/postgres/migrations/000000_initial.sql:289"),
    created: Option<i64> => ("created", "int8", true, "server/postgres/migrations/000000_initial.sql:290"),
    uuid: Option<PgUuid> => ("uuid", "uuid", true, "server/postgres/migrations/000009_add_uuid_to_zinvites.sql:2"),
}

pub const TABLES: &[Table] = &[
    Table {
        name: "apikeysndvweifu",
        columns: ApikeysndvweifuRow::COLUMNS,
        roundtrip: roundtrip::<ApikeysndvweifuRow>,
        decode: decode::<ApikeysndvweifuRow>,
    },
    Table {
        name: "auth_tokens",
        columns: AuthTokensRow::COLUMNS,
        roundtrip: roundtrip::<AuthTokensRow>,
        decode: decode::<AuthTokensRow>,
    },
    Table {
        name: "beta",
        columns: BetaRow::COLUMNS,
        roundtrip: roundtrip::<BetaRow>,
        decode: decode::<BetaRow>,
    },
    Table {
        name: "byod_import_jobs",
        columns: ByodImportJobsRow::COLUMNS,
        roundtrip: roundtrip::<ByodImportJobsRow>,
        decode: decode::<ByodImportJobsRow>,
    },
    Table {
        name: "comment_translations",
        columns: CommentTranslationsRow::COLUMNS,
        roundtrip: roundtrip::<CommentTranslationsRow>,
        decode: decode::<CommentTranslationsRow>,
    },
    Table {
        name: "comments",
        columns: CommentsRow::COLUMNS,
        roundtrip: roundtrip::<CommentsRow>,
        decode: decode::<CommentsRow>,
    },
    Table {
        name: "contexts",
        columns: ContextsRow::COLUMNS,
        roundtrip: roundtrip::<ContextsRow>,
        decode: decode::<ContextsRow>,
    },
    Table {
        name: "contributer_agreement_signatures",
        columns: ContributerAgreementSignaturesRow::COLUMNS,
        roundtrip: roundtrip::<ContributerAgreementSignaturesRow>,
        decode: decode::<ContributerAgreementSignaturesRow>,
    },
    Table {
        name: "conversation_translations",
        columns: ConversationTranslationsRow::COLUMNS,
        roundtrip: roundtrip::<ConversationTranslationsRow>,
        decode: decode::<ConversationTranslationsRow>,
    },
    Table {
        name: "conversations",
        columns: ConversationsRow::COLUMNS,
        roundtrip: roundtrip::<ConversationsRow>,
        decode: decode::<ConversationsRow>,
    },
    Table {
        name: "courses",
        columns: CoursesRow::COLUMNS,
        roundtrip: roundtrip::<CoursesRow>,
        decode: decode::<CoursesRow>,
    },
    Table {
        name: "crowd_mod",
        columns: CrowdModRow::COLUMNS,
        roundtrip: roundtrip::<CrowdModRow>,
        decode: decode::<CrowdModRow>,
    },
    Table {
        name: "demographic_data",
        columns: DemographicDataRow::COLUMNS,
        roundtrip: roundtrip::<DemographicDataRow>,
        decode: decode::<DemographicDataRow>,
    },
    Table {
        name: "einvites",
        columns: EinvitesRow::COLUMNS,
        roundtrip: roundtrip::<EinvitesRow>,
        decode: decode::<EinvitesRow>,
    },
    Table {
        name: "email_validations",
        columns: EmailValidationsRow::COLUMNS,
        roundtrip: roundtrip::<EmailValidationsRow>,
        decode: decode::<EmailValidationsRow>,
    },
    Table {
        name: "event_ptpt_no_more_comments",
        columns: EventPtptNoMoreCommentsRow::COLUMNS,
        roundtrip: roundtrip::<EventPtptNoMoreCommentsRow>,
        decode: decode::<EventPtptNoMoreCommentsRow>,
    },
    Table {
        name: "facebook_friends",
        columns: FacebookFriendsRow::COLUMNS,
        roundtrip: roundtrip::<FacebookFriendsRow>,
        decode: decode::<FacebookFriendsRow>,
    },
    Table {
        name: "facebook_users",
        columns: FacebookUsersRow::COLUMNS,
        roundtrip: roundtrip::<FacebookUsersRow>,
        decode: decode::<FacebookUsersRow>,
    },
    Table {
        name: "inviters",
        columns: InvitersRow::COLUMNS,
        roundtrip: roundtrip::<InvitersRow>,
        decode: decode::<InvitersRow>,
    },
    Table {
        name: "jianiuevyew",
        columns: JianiuevyewRow::COLUMNS,
        roundtrip: roundtrip::<JianiuevyewRow>,
        decode: decode::<JianiuevyewRow>,
    },
    Table {
        name: "math_bidtopid",
        columns: MathBidtopidRow::COLUMNS,
        roundtrip: roundtrip::<MathBidtopidRow>,
        decode: decode::<MathBidtopidRow>,
    },
    Table {
        name: "math_cache",
        columns: MathCacheRow::COLUMNS,
        roundtrip: roundtrip::<MathCacheRow>,
        decode: decode::<MathCacheRow>,
    },
    Table {
        name: "math_exportstatus",
        columns: MathExportstatusRow::COLUMNS,
        roundtrip: roundtrip::<MathExportstatusRow>,
        decode: decode::<MathExportstatusRow>,
    },
    Table {
        name: "math_main",
        columns: MathMainRow::COLUMNS,
        roundtrip: roundtrip::<MathMainRow>,
        decode: decode::<MathMainRow>,
    },
    Table {
        name: "math_profile",
        columns: MathProfileRow::COLUMNS,
        roundtrip: roundtrip::<MathProfileRow>,
        decode: decode::<MathProfileRow>,
    },
    Table {
        name: "math_ptptstats",
        columns: MathPtptstatsRow::COLUMNS,
        roundtrip: roundtrip::<MathPtptstatsRow>,
        decode: decode::<MathPtptstatsRow>,
    },
    Table {
        name: "math_report_correlationmatrix",
        columns: MathReportCorrelationmatrixRow::COLUMNS,
        roundtrip: roundtrip::<MathReportCorrelationmatrixRow>,
        decode: decode::<MathReportCorrelationmatrixRow>,
    },
    Table {
        name: "math_ticks",
        columns: MathTicksRow::COLUMNS,
        roundtrip: roundtrip::<MathTicksRow>,
        decode: decode::<MathTicksRow>,
    },
    Table {
        name: "metrics",
        columns: MetricsRow::COLUMNS,
        roundtrip: roundtrip::<MetricsRow>,
        decode: decode::<MetricsRow>,
    },
    Table {
        name: "notification_tasks",
        columns: NotificationTasksRow::COLUMNS,
        roundtrip: roundtrip::<NotificationTasksRow>,
        decode: decode::<NotificationTasksRow>,
    },
    Table {
        name: "oidc_user_mappings",
        columns: OidcUserMappingsRow::COLUMNS,
        roundtrip: roundtrip::<OidcUserMappingsRow>,
        decode: decode::<OidcUserMappingsRow>,
    },
    Table {
        name: "oinvites",
        columns: OinvitesRow::COLUMNS,
        roundtrip: roundtrip::<OinvitesRow>,
        decode: decode::<OinvitesRow>,
    },
    Table {
        name: "page_ids",
        columns: PageIdsRow::COLUMNS,
        roundtrip: roundtrip::<PageIdsRow>,
        decode: decode::<PageIdsRow>,
    },
    Table {
        name: "participant_locations",
        columns: ParticipantLocationsRow::COLUMNS,
        roundtrip: roundtrip::<ParticipantLocationsRow>,
        decode: decode::<ParticipantLocationsRow>,
    },
    Table {
        name: "participant_metadata_answers",
        columns: ParticipantMetadataAnswersRow::COLUMNS,
        roundtrip: roundtrip::<ParticipantMetadataAnswersRow>,
        decode: decode::<ParticipantMetadataAnswersRow>,
    },
    Table {
        name: "participant_metadata_choices",
        columns: ParticipantMetadataChoicesRow::COLUMNS,
        roundtrip: roundtrip::<ParticipantMetadataChoicesRow>,
        decode: decode::<ParticipantMetadataChoicesRow>,
    },
    Table {
        name: "participant_metadata_questions",
        columns: ParticipantMetadataQuestionsRow::COLUMNS,
        roundtrip: roundtrip::<ParticipantMetadataQuestionsRow>,
        decode: decode::<ParticipantMetadataQuestionsRow>,
    },
    Table {
        name: "participants",
        columns: ParticipantsRow::COLUMNS,
        roundtrip: roundtrip::<ParticipantsRow>,
        decode: decode::<ParticipantsRow>,
    },
    Table {
        name: "participants_extended",
        columns: ParticipantsExtendedRow::COLUMNS,
        roundtrip: roundtrip::<ParticipantsExtendedRow>,
        decode: decode::<ParticipantsExtendedRow>,
    },
    Table {
        name: "permanentcookiezidjoins",
        columns: PermanentcookiezidjoinsRow::COLUMNS,
        roundtrip: roundtrip::<PermanentcookiezidjoinsRow>,
        decode: decode::<PermanentcookiezidjoinsRow>,
    },
    Table {
        name: "polis_coordinator_budgets",
        columns: PolisCoordinatorBudgetsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorBudgetsRow>,
        decode: decode::<PolisCoordinatorBudgetsRow>,
    },
    Table {
        name: "polis_coordinator_cursors",
        columns: PolisCoordinatorCursorsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorCursorsRow>,
        decode: decode::<PolisCoordinatorCursorsRow>,
    },
    Table {
        name: "polis_coordinator_failures",
        columns: PolisCoordinatorFailuresRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorFailuresRow>,
        decode: decode::<PolisCoordinatorFailuresRow>,
    },
    Table {
        name: "polis_coordinator_floors",
        columns: PolisCoordinatorFloorsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorFloorsRow>,
        decode: decode::<PolisCoordinatorFloorsRow>,
    },
    Table {
        name: "polis_coordinator_generations",
        columns: PolisCoordinatorGenerationsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorGenerationsRow>,
        decode: decode::<PolisCoordinatorGenerationsRow>,
    },
    Table {
        name: "polis_coordinator_install",
        columns: PolisCoordinatorInstallRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorInstallRow>,
        decode: decode::<PolisCoordinatorInstallRow>,
    },
    Table {
        name: "polis_coordinator_install_grants",
        columns: PolisCoordinatorInstallGrantsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorInstallGrantsRow>,
        decode: decode::<PolisCoordinatorInstallGrantsRow>,
    },
    Table {
        name: "polis_coordinator_install_roles",
        columns: PolisCoordinatorInstallRolesRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorInstallRolesRow>,
        decode: decode::<PolisCoordinatorInstallRolesRow>,
    },
    Table {
        name: "polis_coordinator_leases",
        columns: PolisCoordinatorLeasesRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorLeasesRow>,
        decode: decode::<PolisCoordinatorLeasesRow>,
    },
    Table {
        name: "polis_coordinator_namespaces",
        columns: PolisCoordinatorNamespacesRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorNamespacesRow>,
        decode: decode::<PolisCoordinatorNamespacesRow>,
    },
    Table {
        name: "polis_coordinator_operations",
        columns: PolisCoordinatorOperationsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorOperationsRow>,
        decode: decode::<PolisCoordinatorOperationsRow>,
    },
    Table {
        name: "polis_coordinator_payloads",
        columns: PolisCoordinatorPayloadsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorPayloadsRow>,
        decode: decode::<PolisCoordinatorPayloadsRow>,
    },
    Table {
        name: "polis_coordinator_principals",
        columns: PolisCoordinatorPrincipalsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorPrincipalsRow>,
        decode: decode::<PolisCoordinatorPrincipalsRow>,
    },
    Table {
        name: "polis_coordinator_reconciliation",
        columns: PolisCoordinatorReconciliationRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorReconciliationRow>,
        decode: decode::<PolisCoordinatorReconciliationRow>,
    },
    Table {
        name: "polis_coordinator_references",
        columns: PolisCoordinatorReferencesRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorReferencesRow>,
        decode: decode::<PolisCoordinatorReferencesRow>,
    },
    Table {
        name: "polis_coordinator_transitions",
        columns: PolisCoordinatorTransitionsRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorTransitionsRow>,
        decode: decode::<PolisCoordinatorTransitionsRow>,
    },
    Table {
        name: "polis_coordinator_writer_authority",
        columns: PolisCoordinatorWriterAuthorityRow::COLUMNS,
        roundtrip: roundtrip::<PolisCoordinatorWriterAuthorityRow>,
        decode: decode::<PolisCoordinatorWriterAuthorityRow>,
    },
    Table {
        name: "polis_queue_attempts",
        columns: PolisQueueAttemptsRow::COLUMNS,
        roundtrip: roundtrip::<PolisQueueAttemptsRow>,
        decode: decode::<PolisQueueAttemptsRow>,
    },
    Table {
        name: "polis_queue_heads",
        columns: PolisQueueHeadsRow::COLUMNS,
        roundtrip: roundtrip::<PolisQueueHeadsRow>,
        decode: decode::<PolisQueueHeadsRow>,
    },
    Table {
        name: "polis_queue_install",
        columns: PolisQueueInstallRow::COLUMNS,
        roundtrip: roundtrip::<PolisQueueInstallRow>,
        decode: decode::<PolisQueueInstallRow>,
    },
    Table {
        name: "polis_queue_jobs",
        columns: PolisQueueJobsRow::COLUMNS,
        roundtrip: roundtrip::<PolisQueueJobsRow>,
        decode: decode::<PolisQueueJobsRow>,
    },
    Table {
        name: "polis_queue_requests",
        columns: PolisQueueRequestsRow::COLUMNS,
        roundtrip: roundtrip::<PolisQueueRequestsRow>,
        decode: decode::<PolisQueueRequestsRow>,
    },
    Table {
        name: "polis_queue_runs",
        columns: PolisQueueRunsRow::COLUMNS,
        roundtrip: roundtrip::<PolisQueueRunsRow>,
        decode: decode::<PolisQueueRunsRow>,
    },
    Table {
        name: "pwreset_tokens",
        columns: PwresetTokensRow::COLUMNS,
        roundtrip: roundtrip::<PwresetTokensRow>,
        decode: decode::<PwresetTokensRow>,
    },
    Table {
        name: "report_comment_selections",
        columns: ReportCommentSelectionsRow::COLUMNS,
        roundtrip: roundtrip::<ReportCommentSelectionsRow>,
        decode: decode::<ReportCommentSelectionsRow>,
    },
    Table {
        name: "reports",
        columns: ReportsRow::COLUMNS,
        roundtrip: roundtrip::<ReportsRow>,
        decode: decode::<ReportsRow>,
    },
    Table {
        name: "site_domain_whitelist",
        columns: SiteDomainWhitelistRow::COLUMNS,
        roundtrip: roundtrip::<SiteDomainWhitelistRow>,
        decode: decode::<SiteDomainWhitelistRow>,
    },
    Table {
        name: "social_settings",
        columns: SocialSettingsRow::COLUMNS,
        roundtrip: roundtrip::<SocialSettingsRow>,
        decode: decode::<SocialSettingsRow>,
    },
    Table {
        name: "stars",
        columns: StarsRow::COLUMNS,
        roundtrip: roundtrip::<StarsRow>,
        decode: decode::<StarsRow>,
    },
    Table {
        name: "suzinvites",
        columns: SuzinvitesRow::COLUMNS,
        roundtrip: roundtrip::<SuzinvitesRow>,
        decode: decode::<SuzinvitesRow>,
    },
    Table {
        name: "topic_agenda_selections",
        columns: TopicAgendaSelectionsRow::COLUMNS,
        roundtrip: roundtrip::<TopicAgendaSelectionsRow>,
        decode: decode::<TopicAgendaSelectionsRow>,
    },
    Table {
        name: "trashes",
        columns: TrashesRow::COLUMNS,
        roundtrip: roundtrip::<TrashesRow>,
        decode: decode::<TrashesRow>,
    },
    Table {
        name: "treevite_invites",
        columns: TreeviteInvitesRow::COLUMNS,
        roundtrip: roundtrip::<TreeviteInvitesRow>,
        decode: decode::<TreeviteInvitesRow>,
    },
    Table {
        name: "treevite_login_codes",
        columns: TreeviteLoginCodesRow::COLUMNS,
        roundtrip: roundtrip::<TreeviteLoginCodesRow>,
        decode: decode::<TreeviteLoginCodesRow>,
    },
    Table {
        name: "treevite_waves",
        columns: TreeviteWavesRow::COLUMNS,
        roundtrip: roundtrip::<TreeviteWavesRow>,
        decode: decode::<TreeviteWavesRow>,
    },
    Table {
        name: "twitter_users",
        columns: TwitterUsersRow::COLUMNS,
        roundtrip: roundtrip::<TwitterUsersRow>,
        decode: decode::<TwitterUsersRow>,
    },
    Table {
        name: "upvotes",
        columns: UpvotesRow::COLUMNS,
        roundtrip: roundtrip::<UpvotesRow>,
        decode: decode::<UpvotesRow>,
    },
    Table {
        name: "users",
        columns: UsersRow::COLUMNS,
        roundtrip: roundtrip::<UsersRow>,
        decode: decode::<UsersRow>,
    },
    Table {
        name: "votes",
        columns: VotesRow::COLUMNS,
        roundtrip: roundtrip::<VotesRow>,
        decode: decode::<VotesRow>,
    },
    Table {
        name: "votes_latest_unique",
        columns: VotesLatestUniqueRow::COLUMNS,
        roundtrip: roundtrip::<VotesLatestUniqueRow>,
        decode: decode::<VotesLatestUniqueRow>,
    },
    Table {
        name: "worker_tasks",
        columns: WorkerTasksRow::COLUMNS,
        roundtrip: roundtrip::<WorkerTasksRow>,
        decode: decode::<WorkerTasksRow>,
    },
    Table {
        name: "xid_whitelist",
        columns: XidWhitelistRow::COLUMNS,
        roundtrip: roundtrip::<XidWhitelistRow>,
        decode: decode::<XidWhitelistRow>,
    },
    Table {
        name: "xids",
        columns: XidsRow::COLUMNS,
        roundtrip: roundtrip::<XidsRow>,
        decode: decode::<XidsRow>,
    },
    Table {
        name: "zinvites",
        columns: ZinvitesRow::COLUMNS,
        roundtrip: roundtrip::<ZinvitesRow>,
        decode: decode::<ZinvitesRow>,
    },
];
