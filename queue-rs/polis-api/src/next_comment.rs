//! Anonymous and existing-participant next-statement reads; unsupported identity, topical and translation work
//! hands back to Node before admission. A separate pool and a short total
//! deadline keep this hop from queuing behind slower API routes.
#[cfg(test)]
use crate::js;
use crate::{
    comments, db,
    http::{Outgoing, Request},
    js::{Js, Obj},
    params,
    route::{self, App, Res},
    shadow::reads,
};
use anyhow::{Result, bail};
use postgres::Client;
use std::time::{Duration, Instant};

pub(crate) use crate::next_priorities::Priorities;

pub const PATH: &str = "/api/v3/nextComment";
const REJECTED_COMMENT_MOD: i32 = -1;
const ANONYMOUS_PARTICIPANT_ID: i32 = -1;
pub(crate) const DEADLINE: Duration = Duration::from_millis(75);
pub(crate) fn pool_limits() -> db::Limits {
    db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(1),
        statement_timeout: Duration::from_millis(50),
        max_lifetime: Duration::from_secs(300),
    }
}
#[derive(Clone, Debug)]
struct Query {
    cid: String,
    without: Vec<i32>,
    initial: Option<i32>,
}
impl Query {
    #[cfg(test)]
    fn parse(req: &Request) -> Option<Self> {
        Self::parse_reasoned(req).ok()
    }

    /// `parse`, with the reason a request is handed back: one word of a
    /// closed set, never a key or a value of the request. The checks and
    /// their results are the same; a copy's observation records the reason.
    fn parse_reasoned(req: &Request) -> Result<Self, &'static str> {
        if !matches!(req.method.as_str(), "GET" | "HEAD") {
            return Err("shape_method");
        }
        if req.headers.get("cookie").is_some() {
            return Err("cookie");
        }
        if ["content-length", "transfer-encoding"]
            .iter()
            .any(|h| req.headers.get(h).is_some())
        {
            return Err("shape_body");
        }
        let p = params::parse_query(req.query().unwrap_or_default());
        // An allowlist also catches identity aliases added to Node later.
        let o = &p;
        if o.iter()
            .any(|(k, _)| !matches!(k.as_str(), "conversation_id" | "without" | "initial_tid"))
        {
            return Err(unlisted_keys(o.iter().map(|(k, _)| k.as_str())));
        }
        let Some(Js::Str(cid)) = o.get("conversation_id") else {
            return Err("no_conversation_id");
        };
        if cid.is_empty() || cid.encode_utf16().count() > 100 {
            return Err("shape_conversation_id");
        }
        let without = match o.get("without") {
            None => vec![],
            Some(Js::Str(s)) => s
                .split(',')
                .map(|s| comments::to_i32(&Js::Str(s.into())))
                .collect(),
            Some(Js::Arr(a)) => a.iter().map(comments::to_i32).collect(),
            _ => return Err("param_without"),
        };
        let initial = match o.get("initial_tid") {
            None => None,
            Some(v) => {
                let n = route::get_int(v).ok_or("param_initial_tid")?;
                if !(0.0..=i32::MAX as f64).contains(&n) {
                    return Err("param_initial_tid");
                }
                Some(n as i32)
            }
        };
        Ok(Self {
            cid: cid.trim_matches(' ').into(),
            without,
            initial,
        })
    }
}
/// The reason for a query that carries a key outside the allowlist, as the
/// class of the keys it carries and never a key: a key no client of this
/// repository sends, an external id, the language (the participation clients
/// send it), a participant number, or the last two together.
fn unlisted_keys<'a>(keys: impl Iterator<Item = &'a str>) -> &'static str {
    let (mut lang, mut pid, mut xid, mut other) = (false, false, false, false);
    for key in keys {
        match key {
            "conversation_id" | "without" | "initial_tid" => {}
            "lang" => lang = true,
            "pid" | "not_voted_by_pid" => pid = true,
            "xid" => xid = true,
            _ => other = true,
        }
    }
    match (other, xid, lang, pid) {
        (true, ..) => "query_key",
        (_, true, ..) => "xid",
        (_, _, true, true) => "lang_and_pid",
        (_, _, true, false) => "lang",
        _ => "pid_parameter",
    }
}
pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    ineligible(app, req).is_none()
}
/// Why the route prelude hands a request back before the handler: `eligible`
/// with its reason. The checks and their results are the same.
pub(crate) fn ineligible(app: &App, req: &Request) -> Option<&'static str> {
    if req.headers.get("authorization").is_some() && app.participant_verifier.is_none() {
        return Some("participant_reads_off");
    }
    if app.next_comment_db.is_none() {
        return Some("unconfigured");
    }
    match Query::parse_reasoned(req) {
        Err(reason) => Some(reason),
        Ok(q) if !(q.initial.is_some() || app.next_comment_plain) => Some("plain_off"),
        Ok(_) => None,
    }
}
pub(crate) fn draw(req: &Request) -> f64 {
    // This header is ignored by production builds. The test feature mirrors
    // the existing Node recorder's per-case xorshift32 entropy, not its RNG.
    #[cfg(feature = "fixture-clock")]
    if let Some(seed) = req
        .headers
        .get("x-polis-fixture-seed")
        .filter(|s| s.len() == 12 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        && let Ok(mut n) = u32::from_str_radix(&seed[..8], 16)
    {
        if n == 0 {
            n = 0x270027;
        }
        n ^= n << 13;
        n ^= n >> 17;
        n ^= n << 5;
        return f64::from(n) / 4294967296.0;
    }
    let _ = req;
    rand::random::<f64>()
}
pub(crate) fn select(tids: &[i32], priorities: Option<&Obj>, unit: f64) -> Result<(usize, f64)> {
    let mut cumulative = Vec::new();
    let mut total = 0.0;
    for tid in tids {
        let weight = match priorities.and_then(|p| p.get(&tid.to_string())) {
            None | Some(Js::Null) | Some(Js::Bool(false)) => 1.0,
            Some(Js::Num(n)) if *n == 0.0 => 1.0,
            Some(Js::Num(n)) if n.is_finite() => *n,
            _ => bail!("unsupported priority type"),
        };
        total += weight;
        cumulative.push(total);
    }
    let random = unit * total;
    let selected = cumulative
        .iter()
        .position(|n| *n > random)
        .ok_or_else(|| anyhow::anyhow!("no weighted candidate"))?;
    Ok((selected, random))
}
#[cfg(all(test, feature = "db-tests"))]
fn read(
    c: &mut Client,
    q: Query,
    math_env: &str,
    unit: f64,
    cache: &Priorities,
    identity: Option<polis_auth::participant::Verified>,
) -> Result<Option<Js>> {
    Ok(
        match read_until(
            c,
            q,
            math_env,
            unit,
            cache,
            identity,
            Instant::now() + DEADLINE,
        )? {
            Read::Answer(payload, _) => Some(payload),
            Read::Handback(..) => None,
        },
    )
}
/// What a read gives: the answer, or the reason it is handed back with the
/// conversation number when the read got that far.
pub(crate) enum Read {
    Answer(Js, Facts),
    Handback(&'static str, Option<i32>),
}
/// What a copy's observation records of an answer. Never the comment.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Facts {
    pub(crate) zid: i32,
    pub(crate) selected: bool,
    pub(crate) remaining: Option<i32>,
    pub(crate) total: Option<i32>,
    /// The math generation the weights of the draw came from.
    pub(crate) weights_tick: Option<i64>,
}
#[allow(clippy::too_many_arguments)]
fn read_until(
    c: &mut Client,
    q: Query,
    math_env: &str,
    unit: f64,
    cache: &Priorities,
    identity: Option<polis_auth::participant::Verified>,
    deadline: Instant,
) -> Result<Read> {
    let Some(zid) = db::zid_for_conversation_id(c, &q.cid)? else {
        return Ok(Read::Handback("unknown_conversation", None));
    };
    let Some(conv) = c.query_opt(
        "select strict_moderation from conversations where zid=$1",
        &[&zid],
    )?
    else {
        return Ok(Read::Handback("unknown_conversation", None));
    };
    let strict = conv.try_get::<_, Option<bool>>(0)?.unwrap_or(false);
    let pid = if let Some(identity) = identity {
        let Some(pid) = polis_auth::participant::resolve(c, polis_auth::Zid(zid), &identity)?
        else {
            return Ok(Read::Handback("not_a_participant", Some(zid)));
        };
        Some(pid.0 as i32)
    } else {
        None
    };
    // A voted initial statement follows Node's normal-selection branch. Keep
    // that branch on Node until its initialStatus and fallback are certified.
    if let (Some(pid), Some(tid)) = (pid, q.initial)
        && !c
            .query(
                "select 1 from votes_latest_unique where zid=$1 and pid=$2 and tid=$3 limit 1",
                &[&zid, &pid, &tid],
            )?
            .is_empty()
    {
        return Ok(Read::Handback("initial_voted", Some(zid)));
    }
    let without = if q.initial.is_some() {
        vec![]
    } else {
        q.without
    };
    // Preserve Node's filters and created-only order. Like Node, read only the
    // ids of every eligible comment (no row limit) and, after the draw, only
    // the chosen comment's row. No participant resolution runs here; initial
    // eligibility retains Node's negative participant sentinel when reading
    // existing votes.
    let tids = c.query(&format!("select tid from comments where zid=$1 AND active=true AND velocity>0 AND (($2::boolean AND mod=1) OR (NOT $2::boolean AND mod != {REJECTED_COMMENT_MOD})) AND NOT(tid=ANY($3::integer[])) AND ($4::integer IS NULL OR (tid=$4 AND tid NOT IN (select tid from votes_latest_unique where zid=$1 AND pid=$5))) AND ($6::integer IS NULL OR tid NOT IN (select tid from votes_latest_unique where zid=$1 AND pid=$6)) order by created"), &[&zid,&strict,&without,&q.initial,&pid.unwrap_or(ANONYMOUS_PARTICIPANT_ID),&pid])?;
    let tids = tids
        .iter()
        .map(|r| r.try_get::<_, i32>(0))
        .collect::<Result<Vec<_>, _>>()?;
    // Node awaits its parallel math/count reads even when the candidate list
    // is empty. Preserve failure handoff instead of manufacturing an empty 200.
    let (data, weights_tick) = if q.initial.is_none() {
        match cache.read_with_tick_until(c, zid, math_env, deadline)? {
            Some((data, tick)) => (Some(data), Some(tick)),
            None => (None, None),
        }
    } else {
        (None, None)
    };
    let counts = if q.initial.is_none() || !tids.is_empty() {
        let counts = c.query_one("WITH v AS (select * from votes_latest_unique where zid=$1 AND pid=$2), c AS (select * from get_visible_comments($1)), remaining AS (select count(*) AS n from c LEFT JOIN v ON c.tid=v.tid WHERE v.vote IS NULL), total AS (select count(*) AS n from c) SELECT remaining.n::integer,total.n::integer FROM remaining,total", &[&zid,&pid.or_else(|| q.initial.map(|_| ANONYMOUS_PARTICIPANT_ID))])?;
        Some((counts.try_get::<_, i32>(0)?, counts.try_get::<_, i32>(1)?))
    } else {
        None
    };
    let facts = Facts {
        zid,
        selected: !tids.is_empty(),
        remaining: counts.map(|(remaining, _)| remaining),
        total: counts.map(|(_, total)| total),
        weights_tick,
    };
    let mut empty = Obj::new();
    if tids.is_empty() {
        if let Some(pid) = pid {
            empty.set("currentPid", Js::Num(f64::from(pid)));
        }
        if q.initial.is_some() {
            empty.set("initialStatus", Js::Str("unavailable".into()));
        }
        return Ok(Read::Answer(Js::Obj(empty), facts));
    }
    let (index, random) = if q.initial.is_some() {
        (0, None)
    } else {
        if data
            .as_ref()
            .and_then(|data| data.as_obj())
            .and_then(|o| o.get("comment-priorities"))
            .is_some_and(|v| matches!(v, Js::Arr(_)))
        {
            bail!("unsupported priority shape");
        }
        let priorities = data
            .as_ref()
            .and_then(|data| data.as_obj())
            .and_then(|o| o.get("comment-priorities"))
            .and_then(|data| data.as_obj());
        let (i, r) = select(&tids, priorities, unit)?;
        (i, Some(r))
    };
    let row = c
        .query_opt(
            "select * from comments where zid=$1 and tid=$2",
            &[&zid, &tids[index]],
        )?
        .ok_or_else(|| anyhow::anyhow!("selected comment missing"))?;
    let mut selected = comments::project(&row)?
        .as_obj()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("invalid comment"))?;
    if let Some(random) = random {
        selected.set("randomN", Js::Num(random));
    }
    // Counts intentionally include muted rows, as get_visible_comments does.
    // They also ignore `without`; both are observable Node behavior.
    let (remaining, total) = counts.ok_or_else(|| anyhow::anyhow!("missing counts"))?;
    selected.set("remaining", Js::Num(f64::from(remaining)));
    selected.set("total", Js::Num(f64::from(total)));
    selected.set("translations", Js::Arr(vec![]));
    if let Some(pid) = pid {
        selected.set("currentPid", Js::Num(f64::from(pid)));
    }
    if q.initial.is_some() {
        selected.set("initialStatus", Js::Str("eligible".into()));
    }
    Ok(Read::Answer(Js::Obj(selected), facts))
}
/// Why the verifier refused a token, as a class and never anything of the
/// token: a token of a kind this read does not admit (`credential_kind`: an
/// external-id participant's; `account_token`: a signed-in account's),
/// another conversation's (`credential_scope`), a header that is not a token
/// this code can read (`credential_shape`), or a participant's token the
/// verifier refused (`token_refused`: its signature, its expiry, a revoked
/// session). Asked only after the verifier has refused; it admits nothing.
fn refused_token(raw: &str, cid: &str) -> &'static str {
    match crate::hybrid_read::handoff_class(Some(raw), true, false, Some(cid)) {
        "participant_token" => "token_refused",
        "oidc_off" => "account_token",
        class => class,
    }
}
pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(pool) = &app.next_comment_db else {
        return reads::handback("unconfigured");
    };
    let q = match Query::parse_reasoned(req) {
        Ok(q) => q,
        Err(reason) => return reads::handback(reason),
    };
    let identity = match req.headers.get("authorization") {
        None => None,
        Some(raw) => {
            let Some(identity) = app
                .participant_verifier
                .as_ref()
                .and_then(|v| v.verify(raw, &q.cid, (crate::clock::now_ms() / 1000.0) as u64))
            else {
                return reads::handback(refused_token(raw, &q.cid));
            };
            Some(identity)
        }
    };
    let math_env = app.math_env.clone();
    let unit = draw(req);
    let cache = app.next_comment_priorities.clone();
    let deadline = Instant::now() + DEADLINE;
    match tokio::time::timeout(
        DEADLINE,
        pool.with(move |c| read_until(c, q, &math_env, unit, &cache, identity, deadline)),
    )
    .await
    {
        Ok(Ok(Read::Answer(payload, facts))) => {
            reads::record(|record| {
                record.zid = Some(facts.zid);
                record.selected = Some(facts.selected);
                record.remaining = facts.remaining.map(i64::from);
                record.total = facts.total.map(i64::from);
                record.weights_tick = facts.weights_tick;
            });
            route::json(req, res, &payload)
        }
        Ok(Ok(Read::Handback(reason, zid))) => {
            reads::record(|record| record.zid = zid);
            reads::handback(reason)
        }
        Ok(Err(error)) => reads::handback(reads::database_reason(&error)),
        Err(_) => {
            #[cfg(all(test, feature = "db-tests"))]
            pool.evidence
                .deadlines
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            reads::handback("deadline")
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Headers;
    const REJECTED_PARAMETER_ID: i32 = -1;
    fn request(q: &str) -> Request {
        Request {
            method: "GET".into(),
            target: format!("{PATH}?{q}"),
            headers: Headers::default(),
            body: vec![],
        }
    }
    #[test]
    fn boundary_refuses_identity_translation_body_and_unknown_fields() {
        let negative_pid = format!("conversation_id=a&not_voted_by_pid={REJECTED_PARAMETER_ID}");
        let negative_tid = format!("conversation_id=a&initial_tid={REJECTED_PARAMETER_ID}");
        for q in [
            "",
            "conversation_id=a&lang=en",
            "conversation_id=a&pid=1",
            negative_pid.as_str(),
            "conversation_id=a&xid=x",
            negative_tid.as_str(),
            "conversation_id=a&initial_tid=bad",
            "conversation_id[]=a",
        ] {
            assert!(Query::parse(&request(q)).is_none(), "{q}");
        }
        for h in ["cookie", "content-length", "transfer-encoding"] {
            let mut r = request("conversation_id=a");
            r.headers = Headers::from_raw([(h, "value")]);
            assert!(Query::parse(&r).is_none());
        }
        let q = Query::parse(&request(
            "conversation_id=a&without=1,bad,0x2&initial_tid=0",
        ))
        .unwrap();
        assert_eq!(q.without, vec![1, 0, 2]);
        assert_eq!(q.initial, Some(0));
    }
    #[test]
    fn weighted_selection_preserves_zero_fallback_and_random_value() {
        let tids = [0, 1];
        let p = js::parse(r#"{"0":0,"1":3}"#).unwrap();
        assert_eq!(select(&tids, p.as_obj(), 0.0).unwrap(), (0, 0.0));
        assert_eq!(select(&tids, p.as_obj(), 0.25).unwrap(), (1, 1.0));
        assert_eq!(select(&tids, None, 0.75).unwrap(), (1, 1.5));
    }
    #[cfg(feature = "db-tests")]
    #[test]
    fn anonymous_reads_preserve_initial_visibility_counts_and_math_weights() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let mut c = Client::connect(&url, postgres::NoTls).unwrap();
        let schema = format!("next_read_test_{}", std::process::id());
        c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
        CREATE TABLE zinvites(zid integer,zinvite text); CREATE TABLE conversations(zid integer,strict_moderation boolean);
        CREATE TABLE comments(zid integer,tid integer,txt text,created bigint,quote_src_url text,is_seed boolean,is_meta boolean,lang text,pid integer,original_id uuid,active boolean,velocity real,mod integer);
        CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote integer);
        CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
        CREATE FUNCTION get_visible_comments(integer) RETURNS TABLE(tid integer) LANGUAGE SQL AS 'select tid from comments where zid=$1 AND active=true AND mod>=0';
        INSERT INTO zinvites VALUES(1,'a'); INSERT INTO conversations VALUES(1,false);
        INSERT INTO comments VALUES (1,0,'first',10,null,true,false,'en',0,null,true,1,0),(1,1,'second',20,null,false,false,'en',1,null,true,1,1),(1,2,'muted',30,null,false,false,'en',1,null,true,0,1),(1,3,'hidden',40,null,false,false,'en',1,null,true,1,-1);
        INSERT INTO math_main VALUES(1,'test',0,'{{\"comment-priorities\":{{\"0\":0,\"1\":3}}}}');")).unwrap();
        let q = |s| Query::parse(&request(s)).unwrap();
        let v = read(
            &mut c,
            q("conversation_id=a"),
            "test",
            0.25,
            &Priorities::new(10),
            None,
        )
        .unwrap()
        .unwrap();
        let o = v.as_obj().unwrap();
        assert_eq!(o.get("tid"), Some(&Js::Num(1.0)));
        assert_eq!(o.get("randomN"), Some(&Js::Num(1.0)));
        assert_eq!(o.get("remaining"), Some(&Js::Num(3.0)));
        assert!(o.get("uid").is_none());
        assert!(o.get("currentPid").is_none());
        let v = read(
            &mut c,
            q("conversation_id=a&initial_tid=0&without=0"),
            "test",
            0.9,
            &Priorities::new(10),
            None,
        )
        .unwrap()
        .unwrap();
        let o = v.as_obj().unwrap();
        assert_eq!(o.get("tid"), Some(&Js::Num(0.0)));
        assert!(o.get("randomN").is_none());
        assert_eq!(o.get("initialStatus"), Some(&Js::Str("eligible".into())));
        assert_eq!(
            read(
                &mut c,
                q("conversation_id=a&initial_tid=3"),
                "test",
                0.0,
                &Priorities::new(10),
                None,
            )
            .unwrap()
            .unwrap(),
            js::parse(r#"{"initialStatus":"unavailable"}"#).unwrap()
        );
        assert_eq!(
            read(
                &mut c,
                q("conversation_id=a&without=0,1"),
                "test",
                0.0,
                &Priorities::new(10),
                None,
            )
            .unwrap()
            .unwrap(),
            Js::Obj(Obj::new())
        );
        let cache = Priorities::new(10);
        let old = cache.read(&mut c, 1, "test").unwrap();
        c.execute(
            "UPDATE math_main SET math_tick=1,data='{\"comment-priorities\":{\"0\":7}}'",
            &[],
        )
        .unwrap();
        assert_eq!(
            cache.read(&mut c, 1, "test").unwrap(),
            old,
            "cached weights must survive until expiry"
        );
        cache.expire(1, "test");
        assert_ne!(
            cache.read(&mut c, 1, "test").unwrap(),
            old,
            "expired weights must refresh"
        );
        c.execute("UPDATE math_main SET math_tick=-1", &[]).unwrap();
        assert!(
            Priorities::new(10)
                .read(&mut c, 1, "test")
                .unwrap()
                .is_none(),
            "uncommitted math must not supply priorities"
        );
        c.batch_execute("DROP FUNCTION get_visible_comments(integer)")
            .unwrap();
        assert!(
            read(
                &mut c,
                q("conversation_id=a&without=0,1"),
                "test",
                0.0,
                &Priorities::new(10),
                None,
            )
            .is_err(),
            "empty normal reads must preserve dependency failures"
        );
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    }
    #[cfg(feature = "db-tests")]
    #[test]
    fn ordinary_reads_draw_from_every_eligible_comment() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let mut c = Client::connect(&url, postgres::NoTls).unwrap();
        let schema = format!("next_all_test_{}", std::process::id());
        c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
        CREATE TABLE zinvites(zid integer,zinvite text); CREATE TABLE conversations(zid integer,strict_moderation boolean);
        CREATE TABLE comments(zid integer,tid integer,txt text,created bigint,quote_src_url text,is_seed boolean,is_meta boolean,lang text,pid integer,original_id uuid,active boolean,velocity real,mod integer);
        CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote integer);
        CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
        CREATE FUNCTION get_visible_comments(integer) RETURNS TABLE(tid integer) LANGUAGE SQL AS 'select tid from comments where zid=$1 AND active=true AND mod>=0';
        INSERT INTO zinvites VALUES(1,'large'); INSERT INTO conversations VALUES(1,false);
        INSERT INTO comments SELECT 1,t,'generated '||t,1700000000000+t,null,false,false,'en',0,null,true,1,0 FROM generate_series(0,1199) t;")).unwrap();
        let mut next = |s: &str, unit: f64| {
            read(
                &mut c,
                Query::parse(&request(s)).unwrap(),
                "test",
                unit,
                &Priorities::new(10),
                None,
            )
            .unwrap()
            .unwrap()
        };
        // 1,200 equal weights: comments past the oldest 999 can be drawn.
        let v = next("conversation_id=large", 0.9999);
        let o = v.as_obj().unwrap();
        assert_eq!(o.get("tid"), Some(&Js::Num(1199.0)));
        assert_eq!(o.get("txt"), Some(&Js::Str("generated 1199".into())));
        assert_eq!(o.get("randomN"), Some(&Js::Num(0.9999 * 1200.0)));
        assert_eq!(o.get("remaining"), Some(&Js::Num(1200.0)));
        assert_eq!(o.get("total"), Some(&Js::Num(1200.0)));
        let v = next("conversation_id=large", 0.5);
        assert_eq!(v.as_obj().unwrap().get("tid"), Some(&Js::Num(600.0)));
        let v = next("conversation_id=large&without=1199", 0.9999);
        assert_eq!(v.as_obj().unwrap().get("tid"), Some(&Js::Num(1198.0)));
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn slower_reads_cannot_occupy_next_statement_slots() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::sync::Arc;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("next_isolation_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
            CREATE TABLE zinvites(zid integer,zinvite text); CREATE TABLE conversations(zid integer,strict_moderation boolean);
            CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote integer);
            CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
            CREATE TABLE comments(zid integer,tid integer,active boolean,velocity real,mod integer,created bigint);
            CREATE FUNCTION get_visible_comments(integer) RETURNS TABLE(tid integer) LANGUAGE SQL AS 'select tid from comments where zid=$1';
            INSERT INTO zinvites VALUES(1,'empty'); INSERT INTO conversations VALUES(1,false);")).unwrap();
        }).await.unwrap();
        let mut pg: postgres::Config = url.parse().unwrap();
        pg.options(&format!("-c search_path={schema}"));
        let make = || db::Pool::new(Connector::Plain(Box::new(pg.clone())), pool_limits());
        let cfg = crate::config::Config {
            listen: String::new(),
            math_env: "test".into(),
            cache_size: 10,
            pca_cache_size: 10,
            pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
            dev_mode: true,
            use_network_host: false,
            production: true,
            pool: pool_limits(),
        };
        let mut app = App::new(&cfg, make());
        app.next_comment_db = Some(make());
        app.next_comment_plain = true;
        app.moderation_comments_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::moderation_comments::pool_limits(),
        ));
        app.moderation_comments_auth_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::moderation_comments::pool_limits(),
        ));
        app.participant_comments_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::participant_comments::pool_limits(),
        ));
        app.participant_comments_auth_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::participant_comments::pool_limits(),
        ));
        app.comments_db = Some(make());
        app.comments_count_db = Some(make());
        app.statement_importance_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::statement_importance::pool_limits(),
        ));
        app.delphi_result_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_result_read::pool_limits(),
        ));
        app.delphi_result_auth_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_result_read::auth_pool_limits(),
        ));
        app.delphi_logs_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_logs::pool_limits(),
        ));
        app.delphi_logs_auth_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_logs::auth_pool_limits(),
        ));
        app.delphi_visualizations_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_visualizations::pool_limits(),
        ));
        app.delphi_visualizations_result_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_visualizations::result_pool_limits(),
        ));
        app.delphi_read_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_read::pool_limits(),
        ));
        app.delphi_topics_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_topics::pool_limits(),
        ));
        app.delphi_narratives_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_narratives::pool_limits(),
        ));
        app.delphi_reports_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::delphi_reports::pool_limits(),
        ));
        app.votes_famous_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::votes_famous::pool_limits(),
        ));
        app.votes_famous_auth_db = Some(db::Pool::new(
            Connector::Plain(Box::new(pg.clone())),
            crate::votes_famous::auth_pool_limits(),
        ));
        let app = Arc::new(app);
        async fn park(
            pool: Arc<db::Pool>,
        ) -> (
            std::sync::mpsc::Sender<()>,
            tokio::task::JoinHandle<Result<()>>,
        ) {
            let (ready, wait) = tokio::sync::oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            let work = tokio::spawn(async move {
                pool.with(move |_| {
                    let _ = ready.send(());
                    held.recv_timeout(Duration::from_secs(5))?;
                    Ok(())
                })
                .await
            });
            wait.await.unwrap();
            (release, work)
        }
        // Measure the same route on an independent, identically configured cold
        // pool in this run. Neither request gets a larger production deadline.
        let mut control = App::new(&cfg, make());
        control.next_comment_db = Some(make());
        control.next_comment_plain = true;
        let control = Arc::new(control);
        async fn observe(app: Arc<App>) -> (u16, Duration, [usize; 6]) {
            let pool = app.next_comment_db.as_ref().unwrap();
            let before = pool.evidence.snapshot();
            let start = std::time::Instant::now();
            let response = route::handle(app.clone(), request("conversation_id=empty")).await;
            let elapsed = start.elapsed();
            // A caller deadline does not cancel its blocking DB operation. Wait
            // for diagnostic completion only; this is not a request timeout.
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let now = pool.evidence.snapshot();
                    if now[3] > before[3] || now[2] > before[2] {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("pool observation never completed");
            let after = pool.evidence.snapshot();
            let delta = std::array::from_fn(|i| after[i] - before[i]);
            (response.status, elapsed, delta)
        }
        fn isolated(sample: &(u16, Duration, [usize; 6])) -> bool {
            let (status, _, [acquired, pending, timeouts, completed, errors, deadlines]) = sample;
            *acquired == 1
                && *pending == 0
                && *timeouts == 0
                && *completed == 1
                && *errors == 0
                && ((*status == 200 && *deadlines == 0) || (*status == 502 && *deadlines == 1))
        }
        let control_sample = observe(control.clone()).await;
        assert!(
            isolated(&control_sample),
            "invalid isolation control: {control_sample:?}"
        );
        // Each of the 20 pools this test saturates stays full through all loaded
        // reads. Counters and available permits witness occupancy directly;
        // a task handle alone could still be pending after releasing its slot.
        let slower = [
            ("general", &app.db),
            ("comments", app.comments_db.as_ref().unwrap()),
            ("comments count", app.comments_count_db.as_ref().unwrap()),
            ("result", app.delphi_result_db.as_ref().unwrap()),
            ("logs", app.delphi_logs_db.as_ref().unwrap()),
            (
                "visualization result",
                app.delphi_visualizations_result_db.as_ref().unwrap(),
            ),
            ("topics", app.delphi_topics_db.as_ref().unwrap()),
            ("narratives", app.delphi_narratives_db.as_ref().unwrap()),
            ("result auth", app.delphi_result_auth_db.as_ref().unwrap()),
            ("importance", app.statement_importance_db.as_ref().unwrap()),
            ("logs auth", app.delphi_logs_auth_db.as_ref().unwrap()),
            (
                "visualizations",
                app.delphi_visualizations_db.as_ref().unwrap(),
            ),
            ("read", app.delphi_read_db.as_ref().unwrap()),
            ("reports", app.delphi_reports_db.as_ref().unwrap()),
            ("moderation", app.moderation_comments_db.as_ref().unwrap()),
            (
                "moderation auth",
                app.moderation_comments_auth_db.as_ref().unwrap(),
            ),
            (
                "participant comments",
                app.participant_comments_db.as_ref().unwrap(),
            ),
            (
                "participant comments auth",
                app.participant_comments_auth_db.as_ref().unwrap(),
            ),
            (
                "featured participants",
                app.votes_famous_db.as_ref().unwrap(),
            ),
            (
                "featured participants identity",
                app.votes_famous_auth_db.as_ref().unwrap(),
            ),
        ]
        .map(|(name, pool)| (name, pool, size(pool)));
        fn size(pool: &db::Pool) -> usize {
            let health = pool.health(true);
            let Js::Num(limit) = health.as_obj().unwrap().get("limit").unwrap() else {
                panic!("pool limit must be a number");
            };
            *limit as usize
        }
        fn available(pool: &db::Pool) -> Js {
            pool.health(true)
                .as_obj()
                .unwrap()
                .get("available")
                .unwrap()
                .clone()
        }
        fn assert_parked(name: &str, pool: &db::Pool, size: usize) {
            assert_eq!(
                pool.evidence.snapshot(),
                [size, 0, 0, 0, 0, 0],
                "slower pool {name} must remain parked"
            );
            assert_eq!(
                available(pool),
                Js::Num(0.0),
                "slower pool {name} must have no free slots"
            );
        }
        let mut held = vec![];
        for (name, pool, size) in &slower {
            for _ in 0..*size {
                held.push(park((*pool).clone()).await);
            }
            assert_parked(name, pool, *size);
        }
        let own = app.next_comment_db.as_ref().unwrap();
        assert_eq!(
            own.evidence.snapshot(),
            [0; 6],
            "slower reads entered the next-statement pool"
        );
        assert_eq!(
            available(own),
            Js::Num(size(own) as f64),
            "slower reads occupied next-statement slots"
        );
        // HTTP 200 witnesses completion inside the route's own deadline. The
        // test-side wall clock also includes parsing and serialization, so it
        // cannot be compared with the database deadline. Allow up to four
        // samples for a host pause; every sample must still prove isolation.
        let mut loaded = vec![];
        for _ in 0..4 {
            let sample = observe(app.clone()).await;
            eprintln!("next statement loaded sample: {sample:?}");
            assert!(
                isolated(&sample),
                "next statement waits on slower routes: control={control_sample:?}, loaded={sample:?}"
            );
            for (name, pool, size) in &slower {
                assert_parked(name, pool, *size);
            }
            assert!(held.iter().all(|(_, work)| !work.is_finished()));
            loaded.push(sample);
            if sample.0 == 200 {
                break;
            }
        }
        assert!(
            loaded
                .iter()
                .any(|sample| sample.0 == 200 && sample.2[5] == 0),
            "next statement missed its {} ms deadline on every loaded request: {loaded:?}",
            DEADLINE.as_millis()
        );
        // A full dedicated pool sheds its own request rather than queueing.
        let mut own_held = vec![];
        for _ in 0..size(own) {
            own_held.push(park(own.clone()).await);
        }
        let starved = observe(app.clone()).await;
        eprintln!("next statement deliberately starved: {starved:?}");
        assert_eq!(starved.0, 502);
        assert_eq!(
            starved.2,
            [0, 1, 1, 0, 0, 0],
            "must shed on pool acquisition"
        );
        assert!(
            !isolated(&starved),
            "test accepted a deliberately starved pool"
        );
        assert!(own_held.iter().all(|(_, work)| !work.is_finished()));
        held.extend(own_held);
        for (release, work) in held {
            release.send(()).unwrap();
            work.await.unwrap().unwrap();
        }
        // The test asserts latency only through the route's own deadline (the
        // HTTP 200 required above). Wall time is printed for diagnosis only,
        // since it also counts parsing, serialization and host scheduling. The
        // production deadline, SQL timeout and acquire timeout are unchanged.
        // No contention, query error or incomplete read is accepted, including
        // after a caller timeout. Bypass libtest capture so CI always records
        // the observed latency.
        let message = format!(
            "next statement isolation: ASSERTED; deadline_ms={}; control={control_sample:?}; loaded={loaded:?}; slower_pools={}; parked_slots={}\n",
            DEADLINE.as_millis(),
            slower.len(),
            slower.iter().map(|(_, _, size)| size).sum::<usize>()
        );
        std::io::Write::write_all(&mut std::io::stdout(), message.as_bytes()).unwrap();
        let refused = own
            .with(|c| {
                c.execute("INSERT INTO conversations VALUES(2,false)", &[])?;
                Ok(())
            })
            .await;
        assert!(refused.is_err(), "dedicated pool must refuse writes");
        // Unsupported identity/translation traffic is refused even with no DB.
        for query in [
            "conversation_id=empty&lang=en",
            "conversation_id=empty&xid=x",
        ] {
            assert_eq!(route::handle(app.clone(), request(query)).await.status, 502);
        }
        let mut disabled = App::new(&cfg, make());
        disabled.next_comment_db = Some(make());
        assert!(!eligible(&disabled, &request("conversation_id=empty")));
        assert!(eligible(
            &disabled,
            &request("conversation_id=empty&initial_tid=0")
        ));
        assert!(!eligible(
            &App::new(&cfg, make()),
            &request("conversation_id=empty&initial_tid=0")
        ));
        tokio::task::spawn_blocking(move || {
            drop(app);
            drop(control);
            drop(disabled);
            let mut c = Client::connect(&setup_url_for_cleanup(), postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
        fn setup_url_for_cleanup() -> String {
            std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap()
        }
    }
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "next_priority_tests.rs"]
mod priority_tests;
