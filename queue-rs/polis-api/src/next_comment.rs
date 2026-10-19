//! Anonymous and existing-participant next-statement reads; unsupported identity, topical and translation work
//! hands back to Node before admission. A separate pool and a short total
//! deadline keep this hop from queuing behind slower API routes.
use crate::{
    comments, db,
    http::{Outgoing, Request},
    js::{self, Js, Obj},
    params,
    route::{self, App, Res},
};
use anyhow::{Result, bail};
use postgres::Client;
use std::{sync::Mutex, time::Duration};

pub(crate) struct Priorities(Mutex<crate::lru::Lru<i32, (f64, Js)>>);
impl Priorities {
    pub(crate) fn new(size: usize) -> Self {
        Self(Mutex::new(crate::lru::Lru::new(size)))
    }
    fn read(&self, c: &mut Client, zid: i32, env: &str) -> Result<Option<Js>> {
        let cached = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("priority cache lock"))?
            .get(&zid);
        if let Some((_, data)) = cached.filter(|(until, _)| *until > crate::clock::now_ms()) {
            return Ok(Some(data));
        }
        let data = db::math_main(c, zid, env)?
            .filter(|m| m.math_tick >= 0)
            .map(|m| js::parse(&m.data))
            .transpose()?;
        if data.as_ref().is_some_and(|d| d.as_obj().is_none()) {
            bail!("unsupported math shape");
        }
        if let Some(data) = &data {
            self.0
                .lock()
                .map_err(|_| anyhow::anyhow!("priority cache lock"))?
                .set(zid, (crate::clock::now_ms() + 3000.0, data.clone()));
        }
        Ok(data)
    }
}

pub const PATH: &str = "/api/v3/nextComment";
const REJECTED_COMMENT_MOD: i32 = -1;
const ANONYMOUS_PARTICIPANT_ID: i32 = -1;
const DEADLINE: Duration = Duration::from_millis(75);
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
    fn parse(req: &Request) -> Option<Self> {
        if !matches!(req.method.as_str(), "GET" | "HEAD")
            || ["cookie", "content-length", "transfer-encoding"]
                .iter()
                .any(|h| req.headers.get(h).is_some())
        {
            return None;
        }
        let p = params::parse_query(req.query().unwrap_or_default());
        // An allowlist also catches identity aliases added to Node later.
        let o = &p;
        if o.iter()
            .any(|(k, _)| !matches!(k.as_str(), "conversation_id" | "without" | "initial_tid"))
        {
            return None;
        }
        let Js::Str(cid) = o.get("conversation_id")? else {
            return None;
        };
        if cid.is_empty() || cid.encode_utf16().count() > 100 {
            return None;
        }
        let without = match o.get("without") {
            None => vec![],
            Some(Js::Str(s)) => s
                .split(',')
                .map(|s| comments::to_i32(&Js::Str(s.into())))
                .collect(),
            Some(Js::Arr(a)) => a.iter().map(comments::to_i32).collect(),
            _ => return None,
        };
        let initial = match o.get("initial_tid") {
            None => None,
            Some(v) => {
                let n = route::get_int(v)?;
                if !(0.0..=i32::MAX as f64).contains(&n) {
                    return None;
                }
                Some(n as i32)
            }
        };
        Some(Self {
            cid: cid.trim_matches(' ').into(),
            without,
            initial,
        })
    }
}
pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    (req.headers.get("authorization").is_none() || app.participant_verifier.is_some())
        && app.next_comment_db.is_some()
        && Query::parse(req).is_some_and(|q| q.initial.is_some() || app.next_comment_plain)
}
fn draw(req: &Request) -> f64 {
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
fn select(rows: &[Js], priorities: Option<&Obj>, unit: f64) -> Result<(usize, f64)> {
    let mut cumulative = Vec::new();
    let mut total = 0.0;
    for row in rows {
        let tid = row
            .as_obj()
            .and_then(|r| r.get("tid"))
            .ok_or_else(|| anyhow::anyhow!("missing tid"))?
            .to_js_string();
        let weight = match priorities.and_then(|p| p.get(&tid)) {
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
fn read(
    c: &mut Client,
    q: Query,
    math_env: &str,
    unit: f64,
    cache: &Priorities,
    identity: Option<polis_auth::participant::Verified>,
) -> Result<Option<Js>> {
    let Some(zid) = db::zid_for_conversation_id(c, &q.cid)? else {
        return Ok(None);
    };
    let Some(conv) = c.query_opt(
        "select strict_moderation from conversations where zid=$1",
        &[&zid],
    )?
    else {
        return Ok(None);
    };
    let strict = conv.try_get::<_, Option<bool>>(0)?.unwrap_or(false);
    let pid = if let Some(identity) = identity {
        let Some(pid) = polis_auth::participant::resolve(c, polis_auth::Zid(zid), &identity)?
        else {
            return Ok(None);
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
        return Ok(None);
    }
    let without = if q.initial.is_some() {
        vec![]
    } else {
        q.without
    };
    // Preserve Node's created-only order, cap, and comment projection. No
    // participant resolution runs here; initial eligibility retains Node's
    // negative participant sentinel when reading existing votes.
    let rows = c.query(&format!("select * from comments where zid=$1 AND active=true AND velocity>0 AND (($2::boolean AND mod=1) OR (NOT $2::boolean AND mod != {REJECTED_COMMENT_MOD})) AND NOT(tid=ANY($3::integer[])) AND ($4::integer IS NULL OR (tid=$4 AND tid NOT IN (select tid from votes_latest_unique where zid=$1 AND pid=$5))) AND ($6::integer IS NULL OR tid NOT IN (select tid from votes_latest_unique where zid=$1 AND pid=$6)) order by created limit 999"), &[&zid,&strict,&without,&q.initial,&pid.unwrap_or(ANONYMOUS_PARTICIPANT_ID),&pid])?;
    let rows = rows
        .iter()
        .map(comments::project)
        .collect::<Result<Vec<_>>>()?;
    // Node awaits its parallel math/count reads even when the candidate list
    // is empty. Preserve failure handoff instead of manufacturing an empty 200.
    let data = if q.initial.is_none() {
        cache.read(c, zid, math_env)?
    } else {
        None
    };
    let counts = if q.initial.is_none() || !rows.is_empty() {
        let counts = c.query_one("WITH v AS (select * from votes_latest_unique where zid=$1 AND pid=$2), c AS (select * from get_visible_comments($1)), remaining AS (select count(*) AS n from c LEFT JOIN v ON c.tid=v.tid WHERE v.vote IS NULL), total AS (select count(*) AS n from c) SELECT remaining.n::integer,total.n::integer FROM remaining,total", &[&zid,&pid.or_else(|| q.initial.map(|_| ANONYMOUS_PARTICIPANT_ID))])?;
        Some((counts.try_get::<_, i32>(0)?, counts.try_get::<_, i32>(1)?))
    } else {
        None
    };
    let mut empty = Obj::new();
    if rows.is_empty() {
        if let Some(pid) = pid {
            empty.set("currentPid", Js::Num(f64::from(pid)));
        }
        if q.initial.is_some() {
            empty.set("initialStatus", Js::Str("unavailable".into()));
        }
        return Ok(Some(Js::Obj(empty)));
    }
    let (index, random) = if q.initial.is_some() {
        (0, None)
    } else {
        if data
            .as_ref()
            .and_then(Js::as_obj)
            .and_then(|o| o.get("comment-priorities"))
            .is_some_and(|v| matches!(v, Js::Arr(_)))
        {
            bail!("unsupported priority shape");
        }
        let priorities = data
            .as_ref()
            .and_then(Js::as_obj)
            .and_then(|o| o.get("comment-priorities"))
            .and_then(Js::as_obj);
        let (i, r) = select(&rows, priorities, unit)?;
        (i, Some(r))
    };
    let mut selected = rows[index]
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
    Ok(Some(Js::Obj(selected)))
}
pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let (Some(pool), Some(q)) = (&app.next_comment_db, Query::parse(req)) else {
        return route::bad_gateway();
    };
    let identity = match req.headers.get("authorization") {
        None => None,
        Some(raw) => {
            let Some(identity) = app
                .participant_verifier
                .as_ref()
                .and_then(|v| v.verify(raw, &q.cid, (crate::clock::now_ms() / 1000.0) as u64))
            else {
                return route::bad_gateway();
            };
            Some(identity)
        }
    };
    let math_env = app.math_env.clone();
    let unit = draw(req);
    let cache = app.next_comment_priorities.clone();
    match tokio::time::timeout(
        DEADLINE,
        pool.with(move |c| read(c, q, &math_env, unit, &cache, identity)),
    )
    .await
    {
        Ok(Ok(Some(payload))) => route::json(req, res, &payload),
        Err(_) => {
            #[cfg(all(test, feature = "db-tests"))]
            pool.evidence
                .deadlines
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            route::bad_gateway()
        }
        _ => route::bad_gateway(),
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
        let rows = vec![
            js::parse(r#"{"tid":0}"#).unwrap(),
            js::parse(r#"{"tid":1}"#).unwrap(),
        ];
        let p = js::parse(r#"{"0":0,"1":3}"#).unwrap();
        assert_eq!(select(&rows, p.as_obj(), 0.0).unwrap(), (0, 0.0));
        assert_eq!(select(&rows, p.as_obj(), 0.25).unwrap(), (1, 1.0));
        assert_eq!(select(&rows, None, 0.75).unwrap(), (1, 1.5));
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
        cache.0.lock().unwrap().set(1, (0.0, old.clone().unwrap()));
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
    // A fixed CPU workload measures scheduling contention without calling any
    // database/read code. Thread CPU time calibrates its uncontended baseline
    // on this machine, so a read-path regression cannot move the threshold.
    #[cfg(feature = "db-tests")]
    fn latency_cpu_probe() -> Option<(Duration, Duration)> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        fn thread_time() -> Option<Duration> {
            let mut time = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            // SAFETY: time is writable and the clock has no borrowed state.
            if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) } != 0 {
                return None;
            }
            Some(Duration::new(
                time.tv_sec.try_into().ok()?,
                time.tv_nsec.try_into().ok()?,
            ))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        fn thread_time() -> Option<Duration> {
            None
        }
        let cpu = thread_time()?;
        let wall = std::time::Instant::now();
        let mut value = 1_u64;
        for _ in 0..32_000_000 {
            value = std::hint::black_box(value.wrapping_mul(1664525).wrapping_add(1013904223));
        }
        std::hint::black_box(value);
        let elapsed = wall.elapsed();
        let baseline = thread_time()?.checked_sub(cpu)?;
        (!baseline.is_zero()).then_some((elapsed, baseline))
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
            dev_mode: true,
            use_network_host: false,
            production: true,
            pool: pool_limits(),
        };
        let mut app = App::new(&cfg, make());
        app.next_comment_db = Some(make());
        app.next_comment_plain = true;
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
        async fn cpu_samples() -> Vec<Option<(Duration, Duration)>> {
            tokio::task::spawn_blocking(|| {
                // A dedicated background thread observes contention suffered by
                // slower work without changing any test/runtime worker priority.
                std::thread::spawn(|| {
                    #[cfg(target_os = "macos")]
                    // SAFETY: this changes only the calling disposable thread.
                    let priority = unsafe {
                        libc::setpriority(libc::PRIO_DARWIN_THREAD, 0, libc::PRIO_DARWIN_BG)
                    };
                    #[cfg(target_os = "linux")]
                    // SAFETY: Linux applies PRIO_PROCESS to this thread's TID.
                    let priority = unsafe {
                        libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 19)
                    };
                    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
                    let priority = -1;
                    (0..1)
                        .map(|_| {
                            if priority == 0 {
                                latency_cpu_probe()
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .join()
                .unwrap()
            })
            .await
            .unwrap()
        }
        let cpu_before = cpu_samples().await;
        // Occupy every slower-route connection and wait until each is held.
        let mut held = vec![];
        for pool in [
            &app.db,
            app.comments_db.as_ref().unwrap(),
            app.comments_count_db.as_ref().unwrap(),
            app.delphi_result_db.as_ref().unwrap(),
            app.delphi_logs_db.as_ref().unwrap(),
            app.delphi_visualizations_result_db.as_ref().unwrap(),
        ] {
            for _ in 0..2 {
                held.push(park(pool.clone()).await);
            }
        }
        held.push(park(app.delphi_result_auth_db.as_ref().unwrap().clone()).await);
        for _ in 0..crate::statement_importance::pool_limits().size {
            held.push(park(app.statement_importance_db.as_ref().unwrap().clone()).await);
        }
        held.push(park(app.delphi_logs_auth_db.as_ref().unwrap().clone()).await);
        held.push(park(app.delphi_visualizations_db.as_ref().unwrap().clone()).await);
        let guarded = observe(app.clone()).await;
        eprintln!(
            "next statement isolation: deadline_ms={} control={control_sample:?} guarded={guarded:?} guarded/control={:.3}",
            DEADLINE.as_millis(),
            guarded.1.as_secs_f64() / control_sample.1.as_secs_f64()
        );
        // Report the absolute deadline and ratio; scheduling time alone is not
        // evidence of starvation. Any pending permit poll fails this guard,
        // even when the request eventually answers within the deadline.
        assert!(
            isolated(&guarded),
            "next statement waits on slower routes: control={control_sample:?}, guarded={guarded:?}"
        );
        assert!(held.iter().all(|(_, work)| !work.is_finished()));
        // A full dedicated pool sheds its own request rather than queueing.
        let own = app.next_comment_db.as_ref().unwrap();
        let first = park(own.clone()).await;
        let second = park(own.clone()).await;
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
            "guard accepted a deliberately starved pool"
        );
        assert!(!first.1.is_finished() && !second.1.is_finished());
        held.extend([first, second]);
        for (release, work) in held {
            release.send(()).unwrap();
            work.await.unwrap().unwrap();
        }
        // Probe outside the parked interval so the diagnostic workload cannot
        // consume the existing five-second hold budget.
        let cpu_after = cpu_samples().await;
        // Require every independent sample to be within 25% of its calibrated
        // CPU baseline. Pool isolation is mandatory even if latency is skipped.
        let quiet = cpu_before
            .iter()
            .chain(&cpu_after)
            .all(|sample| sample.is_some_and(|(wall, baseline)| wall <= baseline.mul_f64(1.1)));
        let message = if quiet {
            format!(
                "next statement latency: ASSERTED; deadline_ms={}; cpu_before={cpu_before:?}; cpu_after={cpu_after:?}; guarded={guarded:?}\n",
                DEADLINE.as_millis()
            )
        } else {
            format!(
                "::warning title=next statement latency::SKIPPED: CPU contention or unavailable thread clock; cpu_before={cpu_before:?}; cpu_after={cpu_after:?}; guarded={guarded:?}; pool isolation still asserted\n"
            )
        };
        // Bypass libtest capture: a passing CI run must visibly name skips.
        std::io::Write::write_all(&mut std::io::stdout(), message.as_bytes()).unwrap();
        if quiet {
            assert!(
                guarded.1 < DEADLINE && guarded.0 == 200,
                "next statement exceeded its quiet-host latency bound: control={control_sample:?}, guarded={guarded:?}"
            );
        }
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
