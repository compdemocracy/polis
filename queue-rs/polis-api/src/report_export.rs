//! Bounded Postgres report exports; external result-backed subtypes stay on Node.
use crate::{
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use postgres::fallible_iterator::FallibleIterator;
use std::collections::{BTreeMap, BTreeSet};
#[path = "../../polis-contracts/src/report_export.rs"]
mod contract;
use contract::{Kind, Response};
/// The Node presentation cache used by the admitted no-math summary path. Locks are
/// held only around bounded in-memory lookups, never around SQL or rendering.
pub struct Cache {
    empty: std::sync::Mutex<crate::lru::Lru<i32, (f64, Option<usize>)>>,
}
impl Cache {
    pub fn new(capacity: usize) -> Self {
        Self {
            empty: std::sync::Mutex::new(crate::lru::Lru::new(capacity)),
        }
    }
    fn presentation(
        &self,
        zid: i32,
        now: f64,
        approved: Option<usize>,
    ) -> anyhow::Result<Option<usize>> {
        let mut cache = self
            .empty
            .lock()
            .map_err(|_| anyhow::anyhow!("report cache poisoned"))?;
        let mut entry = cache
            .get(&zid)
            .filter(|(expiry, _)| *expiry > now)
            .unwrap_or((now + 3000.0, None));
        if entry.1.is_none() {
            entry.1 = approved;
        }
        cache.set(zid, entry);
        Ok(entry.1)
    }
}
pub fn matches(path: &str) -> bool {
    path.strip_prefix(contract::PREFIX)
        .is_some_and(|p| p.split_once('/').is_some())
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.report_export_db.is_none()
        || app.report_export_lookup_db.is_none()
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.query().is_some()
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|v| v != "0")
        || req.headers.get("authorization").is_some()
        || req.headers.get("cookie").is_some()
    {
        return None;
    }
    let (report_id, subtype) = req.path().strip_prefix(contract::PREFIX)?.split_once('/')?;
    if report_id.is_empty()
        || report_id.len() > 100
        || !report_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let kind = Kind::parse(subtype)?;
    // Stream compression has timing-dependent chunk boundaries; retain Node
    // for those requests. Date.toString uses the Node process timezone.
    if kind.streams()
        && req
            .headers
            .get("accept-encoding")
            .is_some_and(|e| e != "identity")
    {
        return None;
    }
    if matches!(kind, Kind::Comments | Kind::Votes) && !app.report_export_utc {
        return None;
    }
    Some(contract::Request {
        report_id: report_id.into(),
        kind,
    })
}
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: std::time::Duration::from_millis(15),
        statement_timeout: std::time::Duration::from_millis(50),
        max_lifetime: std::time::Duration::from_secs(300),
    }
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let (Some(pool), Some(lookup)) = (&app.report_export_db, &app.report_export_lookup_db) else {
        return route::bad_gateway();
    };
    let kind = query.kind;
    let env = app.math_env.clone();
    let site = format!(
        "{}://{}",
        req.headers.get("x-forwarded-proto").unwrap_or("undefined"),
        req.headers.get("host").unwrap_or("undefined")
    );
    if site.len() > 1024 || !site.is_ascii() {
        return route::bad_gateway();
    }
    let cache = app.report_export_cache.clone();
    let now = crate::clock::now_ms();
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(75),
        load(pool, lookup, query, env, site, cache, now),
    )
    .await;
    match result {
        Ok(Some(Response::Json(body))) => route::json_text(req, res, 200, body),
        Ok(Some(Response::Csv(body))) => route::csv(req, res, &body),
        Ok(Some(Response::Stream(chunks))) => route::report_csv_stream(
            req,
            res,
            chunks,
            if kind == Kind::Votes {
                "Content-Type"
            } else {
                "content-type"
            },
        ),
        _ => route::bad_gateway(),
    }
}
// Node resolves the public report ID on its read pool, resolves rid/zid and
// the summary URL on primary, then reads export data on its report/read pool.
async fn load(
    primary: &std::sync::Arc<crate::db::Pool>,
    reads: &std::sync::Arc<crate::db::Pool>,
    query: contract::Request,
    env: String,
    site: String,
    cache: std::sync::Arc<Cache>,
    now: f64,
) -> Option<Response> {
    let id = query.report_id;
    let kind = query.kind;
    let rid = reads
        .with(move |c| {
            let rows = c.query(
                "select rid from reports where report_id = ($1) LIMIT 2",
                &[&id],
            )?;
            Ok(if rows.len() == 1 {
                rows[0].try_get::<_, Option<i64>>(0)?
            } else {
                None
            })
        })
        .await
        .ok()
        .flatten()?;
    let resolved = primary
        .with(move |c| resolve(c, rid, kind))
        .await
        .ok()
        .flatten()?;
    if kind == Kind::Format {
        return Some(Response::Json(contract::FORMAT.into()));
    }
    reads
        .with(move |c| read_cached(c, resolved, kind, &env, &site, &cache, now))
        .await
        .ok()
        .flatten()
}
struct Resolved {
    zid: i32,
    public_id: Option<String>,
}
fn resolve(c: &mut postgres::Client, rid: i64, kind: Kind) -> anyhow::Result<Option<Resolved>> {
    let rows = c.query("select zid from reports where rid = ($1) LIMIT 2", &[&rid])?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let Some(zid) = rows[0].try_get::<_, Option<i32>>(0)?.filter(|v| *v != 0) else {
        return Ok(None);
    };
    let public_id = if kind == Kind::Summary {
        let ids = c.query("SELECT zinvite FROM zinvites WHERE zid=$1 LIMIT 2", &[&zid])?;
        if ids.len() != 1 {
            return Ok(None);
        }
        let id: String = ids[0].try_get(0)?;
        if id.is_empty() || id.len() > 100 {
            return Ok(None);
        }
        Some(id)
    } else {
        None
    };
    Ok(Some(Resolved { zid, public_id }))
}
#[derive(Debug)]
struct Comment {
    tid: i32,
    pid: i32,
    created: Option<i64>,
    text: String,
    moderation: i32,
    velocity: f32,
}
#[derive(Debug)]
struct Vote {
    tid: i32,
    pid: i32,
    created: Option<i64>,
    value: Option<i16>,
    important: bool,
}
fn bounded(
    c: &mut postgres::Client,
    sql: &str,
    zid: i32,
) -> anyhow::Result<Option<Vec<postgres::Row>>> {
    let args: [&(dyn postgres::types::ToSql + Sync); 1] = [&zid];
    let mut stream = c.query_raw(sql, args)?;
    let mut rows = Vec::new();
    while let Some(row) = stream.next()? {
        if rows.len() == 1000 {
            return Ok(None);
        }
        rows.push(row)
    }
    Ok(Some(rows))
}
fn comments(c: &mut postgres::Client, zid: i32) -> anyhow::Result<Option<Vec<Comment>>> {
    let Some(rows) = bounded(
        c,
        "SELECT tid, pid, created, txt, mod, velocity, active FROM comments WHERE zid = ($1)",
        zid,
    )?
    else {
        return Ok(None);
    };
    let mut bytes = 0;
    let mut out = Vec::new();
    for row in rows {
        let text: String = row.try_get(3)?;
        bytes += text.len();
        if bytes > 262144 {
            return Ok(None);
        }
        let velocity: f32 = row.try_get(5)?;
        if !velocity.is_finite() {
            return Ok(None);
        }
        out.push(Comment {
            tid: row.try_get(0)?,
            pid: row.try_get(1)?,
            created: row.try_get(2)?,
            text,
            moderation: row.try_get(4)?,
            velocity,
        });
    }
    Ok(Some(out))
}
fn votes(c: &mut postgres::Client, zid: i32, kind: Kind) -> anyhow::Result<Option<Vec<Vote>>> {
    let sql = match kind {
        Kind::Comments => {
            "SELECT tid, vote, high_priority FROM votes WHERE zid = ($1) ORDER BY tid"
        }
        Kind::ParticipantVotes => {
            "SELECT pid, tid, vote FROM votes WHERE zid = ($1) ORDER BY pid, tid"
        }
        Kind::ParticipantImportance => {
            "SELECT pid, tid, vote, high_priority FROM votes WHERE zid = ($1) ORDER BY pid, tid"
        }
        _ => {
            "SELECT created as timestamp, tid, pid, vote, high_priority FROM votes WHERE zid = $1 ORDER BY tid, pid"
        }
    };
    let Some(rows) = bounded(c, sql, zid)? else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for row in rows {
        let (tid, pid, created, value, important) = match kind {
            Kind::Comments => (
                row.try_get(0)?,
                0,
                None,
                row.try_get(1)?,
                row.try_get::<_, Option<bool>>(2)?.unwrap_or(false),
            ),
            Kind::ParticipantVotes => (
                row.try_get(1)?,
                row.try_get(0)?,
                None,
                row.try_get(2)?,
                false,
            ),
            Kind::ParticipantImportance => (
                row.try_get(1)?,
                row.try_get(0)?,
                None,
                row.try_get(2)?,
                row.try_get::<_, Option<bool>>(3)?.unwrap_or(false),
            ),
            _ => (
                row.try_get(1)?,
                row.try_get(2)?,
                row.try_get(0)?,
                row.try_get(3)?,
                row.try_get::<_, Option<bool>>(4)?.unwrap_or(false),
            ),
        };
        if pid < 0 {
            return Ok(None);
        }
        out.push(Vote {
            tid,
            pid,
            created,
            value,
            important,
        });
    }
    Ok(Some(out))
}
/// Date.toString under TZ=UTC, for bounded nonnegative epoch milliseconds.
fn date(created: Option<i64>) -> Option<(String, String)> {
    let Some(ms) = created else {
        return Some(("NaN".into(), "Invalid Date".into()));
    };
    if !(0..=253402300799999).contains(&ms) {
        return None;
    }
    let seconds = ms / 1000;
    let http = crate::http::http_date(seconds as u64);
    let parts = http.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 6 {
        return None;
    }
    Some((
        seconds.to_string(),
        format!(
            "{} {} {} {} {} GMT+0000 (Coordinated Universal Time)",
            parts[0].trim_end_matches(','),
            parts[2],
            parts[1],
            parts[3],
            parts[4]
        ),
    ))
}
#[cfg(all(test, feature = "db-tests"))]
fn read(
    c: &mut postgres::Client,
    rid: i64,
    kind: Kind,
    env: &str,
    site: &str,
) -> anyhow::Result<Option<Response>> {
    let Some(resolved) = resolve(c, rid, kind)? else {
        return Ok(None);
    };
    read_cached(
        c,
        resolved,
        kind,
        env,
        site,
        &Cache::new(300),
        1700000000000.0,
    )
}
fn read_cached(
    c: &mut postgres::Client,
    resolved: Resolved,
    kind: Kind,
    env: &str,
    site: &str,
    cache: &Cache,
    now: f64,
) -> anyhow::Result<Option<Response>> {
    let Resolved { zid, public_id } = resolved;
    if kind == Kind::Format {
        return Ok(Some(Response::Json(contract::FORMAT.into())));
    }
    if kind.needs_math() {
        // Existing math presentations have process-local generation caches.
        // This initial slice admits conversations without a stored math row;
        // populated/cached generation exports remain with the Node process.
        if !c
            .query(
                "SELECT 1 FROM math_main WHERE zid=$1 AND math_env=$2 LIMIT 1",
                &[&zid, &env],
            )?
            .is_empty()
        {
            return Ok(None);
        }
    }
    let Some(mut comments) = comments(c, zid)? else {
        return Ok(None);
    };
    let approved = if kind.needs_math() {
        cache.presentation(
            zid,
            now,
            matches!(kind, Kind::Summary | Kind::CommentGroups)
                .then(|| comments.iter().filter(|r| r.moderation >= 1).count()),
        )?
    } else {
        None
    };
    if kind == Kind::CommentGroups {
        return Ok(Some(Response::Stream(vec![
            "comment-id,comment,total-votes,total-agrees,total-disagrees,total-passes\n".into(),
        ])));
    }
    if kind == Kind::Summary {
        let Some(id) = public_id else { return Ok(None) };
        let conv = c.query(
            "SELECT topic,description FROM conversations WHERE zid=$1 LIMIT 2",
            &[&zid],
        )?;
        if conv.len() != 1 {
            return Ok(None);
        }
        let topic: String = conv[0].try_get(0)?;
        let description: String = conv[0].try_get(1)?;
        if topic.len() + description.len() + id.len() > 65536 {
            return Ok(None);
        }
        let commenters = comments
            .iter()
            .map(|r| r.pid)
            .collect::<BTreeSet<_>>()
            .len();
        let Some(approved) = approved else {
            return Ok(None);
        };
        let declaration = crate::votes::EXPORT_DECLARATION
            .strip_prefix("# vote-convention: ")
            .unwrap_or_default();
        return Ok(Some(Response::Csv(format!(
            "topic,{}\nurl,{site}/{id}\nvoters,0\nvoters-in-conv,0\ncommenters,{commenters}\ncomments,{approved}\ngroups,0\nconversation-description,{}\nvote-convention,{declaration}",
            contract::escape(&topic),
            contract::escape(&description)
        ))));
    }
    let Some(votes) = votes(c, zid, kind)? else {
        return Ok(None);
    };
    let convention = crate::votes::StorageConvention::CURRENT;
    if kind != Kind::Comments {
        let unique = votes
            .iter()
            .map(|v| (v.tid, v.pid))
            .collect::<BTreeSet<_>>();
        if unique.len() != votes.len() {
            return Ok(None);
        }
    }
    let response = match kind {
        Kind::Comments => {
            comments.sort_by(|a, b| {
                b.velocity
                    .partial_cmp(&a.velocity)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut body="timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,importance,comment-body\n".to_owned();
            for row in comments {
                let Some((timestamp, datetime)) = date(row.created) else {
                    return Ok(None);
                };
                let mut agrees = 0;
                let mut disagrees = 0;
                let mut important = 0;
                for v in votes.iter().filter(|v| v.tid == row.tid) {
                    match convention.decode(v.value.map(i32::from)) {
                        Some(crate::votes::VoteChoice::Agree) => agrees += 1,
                        Some(crate::votes::VoteChoice::Disagree) => disagrees += 1,
                        _ => {}
                    }
                    important += usize::from(v.important);
                }
                body += &format!(
                    "{timestamp},{datetime},{},{},{agrees},{disagrees},{},{important},{}\n",
                    row.tid,
                    row.pid,
                    row.moderation,
                    contract::escape(&row.text)
                );
            }
            Response::Csv(body)
        }
        Kind::Votes => {
            let mut chunks = vec!["timestamp,datetime,comment-id,voter-id,vote,important\n".into()];
            for row in votes {
                let Some((mut timestamp, datetime)) = date(row.created) else {
                    return Ok(None);
                };
                if row.created.is_none() {
                    timestamp = "0".into();
                }
                chunks.push(format!(
                    "{timestamp},{datetime},{},{},{},{}\n",
                    row.tid,
                    row.pid,
                    convention.export_preserving_invalid(row.value),
                    usize::from(row.important)
                ));
            }
            Response::Stream(chunks)
        }
        Kind::ParticipantVotes | Kind::ParticipantImportance => {
            comments.sort_by_key(|r| (r.tid, r.created));
            let ids = comments.iter().map(|r| r.tid).collect::<Vec<_>>();
            let mut header = if kind == Kind::ParticipantVotes {
                "participant,group-id,n-comments,n-votes,n-agree,n-disagree".to_owned()
            } else {
                "participant,group-id,n-comments,n-votes,n-important".to_owned()
            };
            for id in &ids {
                header += &format!(",{id}")
            }
            header.push('\n');
            let mut chunks = vec![header];
            let mut participants: BTreeMap<i32, BTreeMap<i32, &Vote>> = BTreeMap::new();
            for v in &votes {
                let selected = participants.entry(v.pid).or_default();
                if kind == Kind::ParticipantVotes || ids.contains(&v.tid) {
                    selected.insert(v.tid, v);
                }
            }
            for (pid, selected) in participants {
                let ncomments = comments.iter().filter(|r| r.pid == pid).count();
                let mut row = format!("{pid},,{ncomments},{}", selected.len());
                if kind == Kind::ParticipantVotes {
                    let agrees = selected
                        .values()
                        .filter(|v| {
                            convention.decode(v.value.map(i32::from))
                                == Some(crate::votes::VoteChoice::Agree)
                        })
                        .count();
                    let disagrees = selected
                        .values()
                        .filter(|v| {
                            convention.decode(v.value.map(i32::from))
                                == Some(crate::votes::VoteChoice::Disagree)
                        })
                        .count();
                    row += &format!(",{agrees},{disagrees}");
                } else {
                    row += &format!(",{}", selected.values().filter(|v| v.important).count());
                }
                for id in &ids {
                    row.push(',');
                    if let Some(v) = selected.get(id) {
                        row += &if kind == Kind::ParticipantVotes {
                            convention.export_preserving_invalid(v.value).to_string()
                        } else {
                            usize::from(v.important).to_string()
                        };
                    }
                }
                row.push('\n');
                chunks.push(row);
            }
            Response::Stream(chunks)
        }
        _ => return Ok(None),
    };
    let bytes = match &response {
        Response::Json(s) | Response::Csv(s) => s.len(),
        Response::Stream(chunks) => chunks.iter().map(String::len).sum(),
    };
    Ok((bytes <= 1048576).then_some(response))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presentation_retains_counts_until_source_expiry() {
        let cache = Cache::new(2);
        assert_eq!(cache.presentation(1, 1000.0, None).unwrap(), None);
        assert_eq!(cache.presentation(1, 2000.0, Some(3)).unwrap(), Some(3));
        assert_eq!(cache.presentation(1, 3999.0, Some(4)).unwrap(), Some(3));
        assert_eq!(cache.presentation(1, 4000.0, Some(4)).unwrap(), Some(4));
    }
    #[test]
    fn utc_date_bytes_and_invalid_dates_match_the_admitted_range() {
        assert_eq!(
            date(Some(1700000000123)),
            Some((
                "1700000000".into(),
                "Tue Nov 14 2023 22:13:20 GMT+0000 (Coordinated Universal Time)".into()
            ))
        );
        assert_eq!(
            date(Some(0)),
            Some((
                "0".into(),
                "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)".into()
            ))
        );
        assert_eq!(date(None), Some(("NaN".into(), "Invalid Date".into())));
        assert!(date(Some(i64::MAX)).is_none());
    }
    #[cfg(feature = "db-tests")]
    #[test]
    fn read_exports_preserve_semantic_counts_and_bound_math_and_rows() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let schema = format!("report_export_cases_{}", std::process::id());
        c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
            CREATE TABLE reports(rid bigint,zid integer,report_id text);
            CREATE TABLE math_main(zid integer,math_env text);
            CREATE TABLE comments(tid integer,pid integer,created bigint,txt text,mod integer,velocity real,active boolean);
            ALTER TABLE comments ADD zid integer;
            CREATE TABLE votes(tid integer,pid integer,created bigint,vote smallint,high_priority boolean,zid integer);
            CREATE TABLE zinvites(zid integer,zinvite text);
            CREATE TABLE conversations(zid integer,topic text,description text);
            INSERT INTO reports VALUES(1,2,'generated'),(2,NULL,'null');
            INSERT INTO zinvites VALUES(2,'generated');
            INSERT INTO conversations VALUES(2,'generated topic','generated description');
            INSERT INTO comments VALUES(1,3,1700000000000,'generated text',1,1,true,2);")).unwrap();
        for (index, meaning) in [
            crate::votes::VoteChoice::Agree,
            crate::votes::VoteChoice::Disagree,
            crate::votes::VoteChoice::Pass,
        ]
        .into_iter()
        .enumerate()
        {
            let stored = crate::votes::StorageConvention::CURRENT.encode(meaning) as i16;
            c.execute(
                "INSERT INTO votes VALUES(1,$2,1700000000000,$1,true,2)",
                &[&stored, &(index as i32)],
            )
            .unwrap();
        }
        assert_eq!(
            read(&mut c, 1, Kind::Format, "test", "http://localhost").unwrap(),
            Some(Response::Json(contract::FORMAT.into()))
        );
        let Some(Response::Csv(body)) =
            read(&mut c, 1, Kind::Comments, "test", "http://localhost").unwrap()
        else {
            panic!("comments")
        };
        assert!(body.ends_with(",1,3,1,1,1,3,\"generated text\"\n"));
        for kind in [
            Kind::Summary,
            Kind::Votes,
            Kind::ParticipantVotes,
            Kind::ParticipantImportance,
            Kind::CommentGroups,
        ] {
            assert!(
                read(&mut c, 1, kind, "test", "http://localhost")
                    .unwrap()
                    .is_some(),
                "{kind:?}"
            );
        }
        c.batch_execute("INSERT INTO math_main VALUES(2,'test')")
            .unwrap();
        for kind in [
            Kind::Summary,
            Kind::ParticipantVotes,
            Kind::ParticipantImportance,
            Kind::CommentGroups,
        ] {
            assert!(
                read(&mut c, 1, kind, "test", "http://localhost")
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            read(&mut c, 2, Kind::Format, "test", "http://localhost")
                .unwrap()
                .is_none()
        );
        c.batch_execute("INSERT INTO comments SELECT n,3,1700000000000,'generated',1,1,true,2 FROM generate_series(2,1001)n").unwrap();
        assert!(
            read(&mut c, 1, Kind::Comments, "test", "http://localhost")
                .unwrap()
                .is_none()
        );
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn report_identity_and_export_data_use_their_original_sources() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let primary_schema = format!("report_primary_{}", std::process::id());
        let read_schema = format!("report_replica_{}", std::process::id());
        let setup_url = url.clone();
        let ps = primary_schema.clone();
        let rs = read_schema.clone();
        tokio::task::spawn_blocking(move|| {
            let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();
            for schema in [&ps,&rs] {
                c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
                    CREATE TABLE reports(rid bigint,zid integer,report_id text);
                    CREATE TABLE zinvites(zid integer,zinvite text);
                    CREATE TABLE conversations(zid integer,topic text,description text);
                    CREATE TABLE math_main(zid integer,math_env text);
                    CREATE TABLE comments(zid integer,tid integer,pid integer,created bigint,txt text,mod integer,velocity real,active boolean);")).unwrap();
            }
            c.batch_execute(&format!("SET search_path={ps};
                INSERT INTO reports VALUES(7000000000,9,'primary-only');
                INSERT INTO zinvites VALUES(9,'primarycode');
                INSERT INTO conversations VALUES(9,'primary topic','primary description');
                INSERT INTO math_main VALUES(9,'test');
                INSERT INTO comments VALUES(9,1,1,0,'primary',1,1,true),(9,2,2,0,'primary',1,1,true);
                SET search_path={rs};
                INSERT INTO reports VALUES(7000000000,99,'generated');
                INSERT INTO zinvites VALUES(9,'wrongcode');
                INSERT INTO conversations VALUES(9,'replica topic','replica description');
                INSERT INTO comments VALUES(9,1,1,0,'replica',1,1,true);")).unwrap();
        }).await.unwrap();
        let make = |schema: &str| {
            let mut config: postgres::Config = url.parse().unwrap();
            config.options(&format!("-c search_path={schema}"));
            crate::db::Pool::new(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(config)),
                pool_limits(),
            )
        };
        let primary = make(&primary_schema);
        let reads = make(&read_schema);
        let answer = load(
            &primary,
            &reads,
            contract::Request {
                report_id: "generated".into(),
                kind: Kind::Summary,
            },
            "test".into(),
            "http://localhost".into(),
            std::sync::Arc::new(Cache::new(2)),
            1700000000000.0,
        )
        .await;
        tokio::task::spawn_blocking(move || {
            drop(primary);
            drop(reads);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "DROP SCHEMA {primary_schema} CASCADE; DROP SCHEMA {read_schema} CASCADE"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let Some(Response::Csv(body)) = answer else {
            panic!("summary must read each source correctly")
        };
        assert!(body.starts_with("topic,\"replica topic\"\nurl,http://localhost/primarycode\n"));
        assert!(body.contains("\ncommenters,1\ncomments,1\n"));
        assert!(body.contains("conversation-description,\"replica description\""));
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn report_pool_is_read_only_and_does_not_take_participation_slots() {
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let make = || {
            crate::db::Pool::new(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
                    url.parse().unwrap(),
                )),
                pool_limits(),
            )
        };
        let report = make();
        let participation = make();
        assert!(report.ping().await);
        assert!(participation.ping().await);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let work = report.clone();
        let task = tokio::spawn(async move {
            work.with(move |c| {
                let _ = tx.send(());
                c.batch_execute("SELECT pg_sleep(5)")?;
                Ok(())
            })
            .await
        });
        rx.await.unwrap();
        assert!(participation.ping().await);
        assert!(report.with(|_| Ok(())).await.is_err());
        assert!(task.await.unwrap().is_err());
        let error = report
            .with(|c| {
                c.batch_execute("CREATE TABLE report_must_not_write(a integer)")?;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(report);
            drop(participation);
        })
        .await
        .unwrap();
    }
}
