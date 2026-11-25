//! The whole request against PostgreSQL. The result store's objects the route
//! reads are stand-ins with their names, signatures and the shapes of their
//! answers (`delphi_result_publications`, `delphi_result_jobs`,
//! `pd_run_record`, `pd_result_artifact_wire`), and the stored map family is
//! written here as the codec writes it (one canonical line per part), so
//! every statement the route sends is parsed, typed and answered by a real
//! server. The family `Delphi_TopicMapDocument` is not yet in the result
//! catalog; these fixtures are its definition.
use super::*;
use super::{ZID, bytes, document, get, header, small_map, text};
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use postgres::NoTls;
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) struct Db {
    admin: postgres::Client,
    name: String,
    pub(crate) config: postgres::Config,
}

/// The result store's objects the route reads, and the tables the moderator
/// rule and the moderation read read; `reports` too unless the database has
/// it.
pub(crate) fn stand_ins(c: &mut postgres::Client, reports: bool) {
    if reports {
        c.batch_execute("CREATE TABLE reports(report_id text, zid integer)")
            .unwrap();
    }
    c.batch_execute(
        "CREATE TABLE IF NOT EXISTS users(uid integer, site_id text);
         CREATE TABLE IF NOT EXISTS oidc_user_mappings(uid integer, oidc_sub text);
         CREATE TABLE IF NOT EXISTS conversations(zid integer, owner integer);
         CREATE TABLE IF NOT EXISTS comments(zid integer, tid integer, mod integer,
           active boolean NOT NULL DEFAULT true, velocity real NOT NULL DEFAULT 1);
         CREATE TABLE delphi_result_publications(env text, zid integer, scope_key text,
           generation bigint, artifact_id uuid, job_id text);
         CREATE TABLE delphi_result_jobs(env text, job_id text, conversation_id text,
           status text, job_config jsonb, created_at text,
           job_type text NOT NULL DEFAULT 'full_pipeline');
         CREATE INDEX ON delphi_result_jobs(env, conversation_id);
         CREATE TABLE delphi_job_aliases(public_id text PRIMARY KEY, job_id uuid NOT NULL,
           source text NOT NULL);
         CREATE TABLE stand_in_runs(env text, job_id uuid, record jsonb);
         CREATE TABLE stand_in_wires(env text, artifact_id uuid, family text, wire text,
           delay float8 NOT NULL DEFAULT 0);
         CREATE FUNCTION pd_run_record(p_env text, p_job uuid) RETURNS jsonb
           LANGUAGE sql STABLE AS
           $$ SELECT record FROM stand_in_runs WHERE env=p_env AND job_id=p_job $$;
         CREATE FUNCTION pd_result_artifact_wire(p_env text, p_artifact uuid, p_family text)
           RETURNS jsonb LANGUAGE sql STABLE AS
           $$ SELECT jsonb_build_object('wire',wire,'sha256',encode(sha256(convert_to(wire,'UTF8')),'hex'),
                'batch_sha256',NULL,'batch_id',NULL)
              FROM stand_in_wires w, LATERAL (SELECT pg_sleep(w.delay)) z
              WHERE env=p_env AND artifact_id=p_artifact AND family=p_family $$;",
    )
    .unwrap();
}

impl Db {
    pub(crate) fn new(label: &str) -> Self {
        let mut config: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
            .unwrap()
            .parse()
            .unwrap();
        let mut admin = config.connect(NoTls).unwrap();
        let name = format!("topic_map_{label}_{}", std::process::id());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        config.dbname(&name);
        let db = Self {
            admin,
            name,
            config,
        };
        stand_ins(&mut db.connect(), true);
        db
    }
    pub(crate) fn connect(&self) -> postgres::Client {
        self.config.connect(NoTls).unwrap()
    }
    pub(crate) fn pool(&self, limits: crate::db::Limits) -> Arc<crate::db::Pool> {
        crate::db::Pool::new(Connector::Plain(Box::new(self.config.clone())), limits)
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        let _ = self.admin.batch_execute(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ));
    }
}

/// A stored map's three parts.
pub(crate) struct Stored {
    pub(crate) document: String,
    pub(crate) gzip: Vec<u8>,
    pub(crate) sha256: String,
}

pub(crate) fn stored(document: String) -> Stored {
    let gzip = crate::compress::node_stream(document.as_bytes(), true)
        .unwrap()
        .concat();
    let sha256 = Sha256::digest(document.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Stored {
        document,
        gzip,
        sha256,
    }
}

/// Where a fixture's rows name their job: [`served`] and [`wire_at`] put the
/// run's job id in its place.
pub(crate) const JOB: &str = "@job@";

/// One row's canonical line, as the codec writes it: the attributes in byte
/// order, no spaces, each value tagged; `conversation_id`, `part` and
/// `job_id` ([`JOB`]) added.
fn line(zid: i32, part: &str, attributes: &[(&str, &str, &str)]) -> String {
    let mut all: Vec<(String, String)> = vec![
        ("conversation_id".into(), format!(r#"{{"S":"{zid}"}}"#)),
        ("part".into(), format!(r#"{{"S":"{part}"}}"#)),
        (contract::JOB_ID.into(), format!(r#"{{"S":"{JOB}"}}"#)),
    ];
    for (name, tag, value) in attributes {
        let value = if *tag == "N" {
            format!(r#"{{"N":"{value}"}}"#)
        } else {
            format!(r#"{{"{tag}":{}}}"#, serde_json::to_string(value).unwrap())
        };
        all.push(((*name).into(), value));
    }
    all.sort();
    let body: Vec<String> = all
        .iter()
        .map(|(k, v)| format!("{}:{v}", serde_json::to_string(k).unwrap()))
        .collect();
    format!("{{{}}}", body.join(","))
}

fn family(lines: &[String]) -> String {
    let mut out = String::from(
        r#"{"codec":"delphi-storage-codec/1","family":"Delphi_TopicMapDocument","key":["conversation_id","part"]}"#,
    );
    out.push('\n');
    for l in lines {
        out.push_str(l);
        out.push('\n');
    }
    out
}

/// The family of a stored map, as the step writes it: the three parts in key
/// order.
pub(crate) fn map_family(zid: i32, s: &Stored) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(&s.gzip);
    let (doc_len, gz_len) = (s.document.len().to_string(), s.gzip.len().to_string());
    family(&[
        line(
            zid,
            contract::PART_DOCUMENT,
            &[
                (contract::BODY, "S", &s.document),
                ("bytes", "N", &doc_len),
                ("schema", "S", contract::SCHEMA),
            ],
        ),
        line(
            zid,
            contract::PART_GZIP,
            &[(contract::BODY, "B", &b64), ("bytes", "N", &gz_len)],
        ),
        line(
            zid,
            contract::PART_SHA256,
            &[(contract::BODY, "S", &s.sha256)],
        ),
    ])
}

/// The family of a run that stored no map, for `reason`.
pub(crate) fn no_map_family(zid: i32, reason: &str) -> String {
    family(&[line(
        zid,
        contract::PART_NO_MAP,
        &[(contract::REASON, "S", reason)],
    )])
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(100);

pub(crate) fn uuid(kind: u16) -> String {
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    format!("00000000-0000-4000-{kind:04x}-{n:012}")
}

/// A run: its job row, and its record listing the map family at `artifact`
/// (produced by `producer`) when given.
pub(crate) fn run(
    c: &mut postgres::Client,
    env: &str,
    job: &str,
    zid: i32,
    status: &str,
    selection: &str,
    map_at: Option<(&str, &str)>,
) {
    c.execute(
        "INSERT INTO delphi_result_jobs VALUES($1,$2,$3,$4,$5::text::jsonb)",
        &[
            &env,
            &job,
            &zid.to_string(),
            &status,
            &json!({"selection": selection}).to_string(),
        ],
    )
    .unwrap();
    let families: Vec<_> = map_at
        .map(|(artifact, producer)| {
            json!({"family": contract::FAMILY, "artifact_id": artifact, "job_id": producer,
                "batch_id": uuid(0x9000), "row_count": 3, "served": true, "scope": "delphi"})
        })
        .into_iter()
        .collect();
    c.execute(
        "INSERT INTO stand_in_runs VALUES($1,$2::text::uuid,$3::text::jsonb)",
        &[
            &env,
            &job,
            &json!({"job_id": job, "zid": zid, "families": families}).to_string(),
        ],
    )
    .unwrap();
}

/// The map family at `artifact`, its rows naming `job`.
pub(crate) fn wire_at(c: &mut postgres::Client, env: &str, artifact: &str, wire: &str, job: &str) {
    c.execute(
        "INSERT INTO stand_in_wires(env, artifact_id, family, wire) VALUES($1,$2::text::uuid,$3,$4)",
        &[&env, &artifact, &contract::FAMILY, &wire.replace(JOB, job)],
    )
    .unwrap();
}

pub(crate) fn publish(
    c: &mut postgres::Client,
    env: &str,
    zid: i32,
    scope: &str,
    job: &str,
    artifact: &str,
) {
    c.execute(
        "INSERT INTO delphi_result_publications VALUES($1,$2,$3,1,$4::text::uuid,$5)",
        &[&env, &zid, &scope, &artifact, &job],
    )
    .unwrap();
}

/// A served run of `zid` in `scope` whose own artifact holds `wire`.
pub(crate) fn served(
    c: &mut postgres::Client,
    env: &str,
    zid: i32,
    scope: &str,
    selection: &str,
    wire: Option<&str>,
) -> String {
    let (job, artifact) = (uuid(0x8000), uuid(0xa000));
    run(
        c,
        env,
        &job,
        zid,
        "COMPLETED",
        selection,
        wire.map(|_| (artifact.as_str(), job.as_str())),
    );
    if let Some(wire) = wire {
        wire_at(c, env, &artifact, wire, &job);
    }
    publish(c, env, zid, scope, &job, &artifact);
    job
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

pub(crate) fn app_on(db: &Db) -> App {
    let mut app = super::app();
    app.delphi_topic_map_db = Some(db.pool(pool_limits()));
    app.delphi_topic_map_auth_db = Some(db.pool(auth_pool_limits()));
    app.delphi_topic_map_env = "test".into();
    app.delphi_topic_map_derived = true;
    app
}

fn with(target: &str, headers: &[(&str, &str)]) -> Request {
    let mut req = get(target);
    let mut all = vec![("host", "localhost"), ("x-forwarded-proto", "https")];
    all.extend_from_slice(headers);
    req.headers = crate::http::Headers::from_raw(all);
    req
}

#[test]
fn a_report_answers_its_served_runs_map_as_stored() {
    let db = Db::new("served");
    let map = stored(document(500, "j"));
    let job = {
        let mut c = db.connect();
        c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID})"))
            .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi",
            "participant_visible/1",
            Some(&map_family(ZID, &map)),
        )
    };
    runtime().block_on(async {
        let app = Arc::new(app_on(&db));
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        let etag = format!("W/\"{}\"", map.sha256);
        // A browser: the stored gzip, as stored.
        let out = crate::dispatch(
            app.clone(),
            None,
            with(url, &[("accept-encoding", "gzip, deflate, br")]),
        )
        .await;
        assert_eq!(out.status, 200);
        assert_eq!(bytes(&out), map.gzip);
        assert_eq!(header(&out, "Content-Encoding"), Some("gzip"));
        assert_eq!(header(&out, "ETag"), Some(etag.as_str()));
        assert_eq!(header(&out, "Vary"), Some("Accept-Encoding"));
        // The API's default: revalidate with the ETag, as every read here.
        assert_eq!(header(&out, "Cache-Control"), Some("no-cache"));
        assert_eq!(header(&out, contract::HEADER_JOB), Some(job.as_str()));
        assert_eq!(header(&out, contract::HEADER_SOURCE), Some("served"));
        assert_eq!(header(&out, contract::HEADER_SCOPE), Some("delphi"));
        assert_eq!(
            header(&out, contract::HEADER_SELECTION),
            Some("participant_visible/1")
        );
        // A client without gzip: the stored document, the contract's type.
        let out = crate::dispatch(app.clone(), None, with(url, &[])).await;
        assert_eq!(out.status, 200);
        assert_eq!(text(&out), map.document);
        assert_eq!(header(&out, "Content-Encoding"), None);
        let doc: contract::TopicMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(doc.points.id.len(), 500);
        // Naming the participants' rule is the same public read.
        let out = crate::dispatch(
            app.clone(),
            None,
            with(
                &format!("{url}&selection=participant_visible&source=served"),
                &[],
            ),
        )
        .await;
        assert_eq!(text(&out), map.document);
        // HEAD: the document's length, no body.
        let mut head = with(url, &[("accept-encoding", "gzip")]);
        head.method = "HEAD".into();
        let out = crate::dispatch(app.clone(), None, head).await;
        assert_eq!(out.status, 200);
        assert_eq!(
            header(&out, "Content-Length"),
            Some(map.document.len().to_string().as_str())
        );
        // The client's copy is current: 304, and no part crosses the connection.
        for tag in [
            etag.clone(),
            format!("\"{}\"", map.sha256),
            "*".into(),
            format!("\"{}\", {etag}", "0".repeat(64)),
        ] {
            let out = crate::dispatch(
                app.clone(),
                None,
                with(url, &[("accept-encoding", "gzip"), ("if-none-match", &tag)]),
            )
            .await;
            assert_eq!(out.status, 304, "{tag}");
            assert!(bytes(&out).is_empty());
            assert_eq!(header(&out, "ETag"), Some(etag.as_str()));
        }
        let stale = format!("W/\"{}\"", "0".repeat(64));
        let out = crate::dispatch(
            app.clone(),
            None,
            with(
                url,
                &[("accept-encoding", "gzip"), ("if-none-match", &stale)],
            ),
        )
        .await;
        assert_eq!(out.status, 200);
        let state = &app.delphi_topic_map;
        assert_eq!(state.0.held.load(Ordering::SeqCst), 0, "nothing is kept");
        // The family is checked once against its digest, holding both parts
        // for that check; afterwards one part at a time.
        assert_eq!(state.checked(), 1, "one check for the family, kept");
        assert_eq!(
            state.max_held(),
            map.document.len() + map.gzip.len(),
            "the check holds the document and its gzip, once"
        );
        assert_eq!(state.max_in_flight(), 1);
    });
}

#[test]
fn runs_without_a_map_and_each_refusal_answer_clearly() {
    let db = Db::new("refusals");
    let map = stored(document(5, "j"));
    {
        let mut c = db.connect();
        c.batch_execute(
            "INSERT INTO reports VALUES('r0',0),('rnull',NULL),('none',11),('before',12),
               ('carried',13),('large',14),('few',15),('odd',16),('huge',17),('long',18),
               ('badsha',19),('nogz',20),('twice',21),('foreign',22),('zeros',23),('badgz',24),
               ('otherdoc',25),('othergz',26),('slow',27),('badcrc',28),('badflag',29),
               ('trailing',30),('badhcrc',31)",
        )
        .unwrap();
        let p = "participant_visible/1";
        // A run from before runs stored maps.
        served(&mut c, "test", 12, "delphi", p, None);
        // The trap: the served run's own batch holds no map, while its record
        // lists an earlier run's (a read that walks earlier batches finds it).
        // That earlier map is not this run's.
        let (job, earlier, artifact) = (uuid(0x8000), uuid(0x8000), uuid(0xa000));
        run(
            &mut c,
            "test",
            &job,
            13,
            "COMPLETED",
            p,
            Some((&artifact, &earlier)),
        );
        wire_at(&mut c, "test", &artifact, &map_family(13, &map), &earlier);
        publish(&mut c, "test", 13, "delphi", &job, &uuid(0xa000));
        served(
            &mut c,
            "test",
            14,
            "delphi",
            p,
            Some(&no_map_family(14, "too_large")),
        );
        served(
            &mut c,
            "test",
            15,
            "delphi",
            p,
            Some(&no_map_family(15, "too_few_comments")),
        );
        served(
            &mut c,
            "test",
            16,
            "delphi",
            p,
            Some(&no_map_family(16, "too_pretty")),
        );
        // A part longer than a stored row, and a family longer than the
        // route splits.
        let big = stored("x".repeat(MAX_PART_BYTES as usize + 10));
        served(&mut c, "test", 17, "delphi", p, Some(&map_family(17, &big)));
        let mut long = map_family(18, &map);
        long.push_str(&line(
            18,
            "padding",
            &[(contract::BODY, "S", &"p".repeat(MAX_FAMILY_BYTES as usize))],
        ));
        long.push('\n');
        served(&mut c, "test", 18, "delphi", p, Some(&long));
        let bad = Stored {
            sha256: "not-a-digest".into(),
            ..stored(document(5, "j"))
        };
        served(&mut c, "test", 19, "delphi", p, Some(&map_family(19, &bad)));
        let no_gzip = family(&[
            line(
                20,
                contract::PART_DOCUMENT,
                &[(contract::BODY, "S", &map.document)],
            ),
            line(
                20,
                contract::PART_SHA256,
                &[(contract::BODY, "S", &map.sha256)],
            ),
        ]);
        served(&mut c, "test", 20, "delphi", p, Some(&no_gzip));
        // Two served pointers for one scope cannot be; read as stored data
        // this route does not read.
        served(&mut c, "test", 21, "delphi", p, Some(&map_family(21, &map)));
        served(&mut c, "test", 21, "delphi", p, Some(&map_family(21, &map)));
        // Rows in the run's own batch that name another job.
        let (job, artifact) = (uuid(0x8000), uuid(0xa000));
        run(
            &mut c,
            "test",
            &job,
            22,
            "COMPLETED",
            p,
            Some((&artifact, &job)),
        );
        wire_at(
            &mut c,
            "test",
            &artifact,
            &map_family(22, &map),
            &uuid(0x8000),
        );
        publish(&mut c, "test", 22, "delphi", &job, &artifact);
        // A digest of the right shape that is not the document's.
        let zeros = Stored {
            sha256: "0".repeat(64),
            ..stored(document(5, "j"))
        };
        served(
            &mut c,
            "test",
            23,
            "delphi",
            p,
            Some(&map_family(23, &zeros)),
        );
        // A gzip of another document.
        let badgz = Stored {
            gzip: stored(document(6, "j")).gzip,
            ..stored(document(5, "j"))
        };
        served(
            &mut c,
            "test",
            24,
            "delphi",
            p,
            Some(&map_family(24, &badgz)),
        );
        // The document's own gzip, made one a conforming decoder refuses: a
        // wrong trailer CRC, a reserved flag bit, a byte after the member,
        // and a wrong header CRC. Each inflates to exactly the document.
        let good = stored(document(5, "j")).gzip;
        let n = good.len();
        let mut badcrc = good.clone();
        badcrc[n - 8] ^= 1;
        let mut badflag = good.clone();
        badflag[3] |= 0x20;
        let trailing = [&good[..], &[0]].concat();
        let mut header = good[..10].to_vec();
        header[3] |= 2;
        let check = (!(crate::delphi_topic_map::crc32(&header) as u16)).to_le_bytes();
        let badhcrc = [&header[..], &check, &good[10..]].concat();
        for (zid, gzip) in [(28, badcrc), (29, badflag), (30, trailing), (31, badhcrc)] {
            let bad = Stored {
                gzip,
                ..stored(document(5, "j"))
            };
            served(
                &mut c,
                "test",
                zid,
                "delphi",
                p,
                Some(&map_family(zid, &bad)),
            );
        }
        // The digest names the run's job, the document (or the gzip) another.
        let other = uuid(0x8000);
        for (zid, row) in [(25, 0), (26, 1)] {
            let mut rows: Vec<String> = map_family(zid, &map)
                .lines()
                .skip(1)
                .map(str::to_owned)
                .collect();
            rows[row] = rows[row].replace(JOB, &other);
            served(&mut c, "test", zid, "delphi", p, Some(&family(&rows)));
        }
        served(&mut c, "test", 27, "delphi", p, Some(&map_family(27, &map)));
        c.execute(
            "UPDATE stand_in_wires SET delay=2.5 WHERE wire LIKE '%\"conversation_id\":{\"S\":\"27\"}%'",
            &[],
        )
        .unwrap();
    }
    runtime().block_on(async {
        let app = Arc::new(app_on(&db));
        let gz = [("accept-encoding", "gzip")];
        let ask = |report: &str| with(&format!("/api/v3/delphi/topicMap?report_id={report}"), &gz);
        for (report, status, body) in [
            ("absent", 404, r#"{"status":"error","message":"Could not find conversation for report_id","report_id":"absent"}"#),
            ("r0", 404, r#"{"status":"error","message":"Could not find conversation for report_id","report_id":"r0"}"#),
            ("rnull", 404, r#"{"status":"error","message":"Could not find conversation for report_id","report_id":"rnull"}"#),
            ("none", 200, r#"{"status":"success","message":"No Delphi run found for this report","report_id":"none","job_id":null,"source":"served","scope":"delphi","reason":"no_run"}"#),
            ("large", 422, r#"{"status":"error","message":"polis_err_topic_map_too_large"}"#),
            ("long", 422, r#"{"status":"error","message":"polis_err_topic_map_too_large"}"#),
        ] {
            let out = crate::dispatch(app.clone(), None, ask(report)).await;
            assert_eq!((out.status, text(&out).as_str()), (status, body), "{report}");
        }
        // A part longer than a stored row refuses the whole map, whichever
        // part is asked for: its document cannot be checked against its
        // digest, so neither part is sent.
        let huge = "/api/v3/delphi/topicMap?report_id=huge";
        for headers in [&[][..], &gz[..]] {
            let out = crate::dispatch(app.clone(), None, with(huge, headers)).await;
            assert_eq!((out.status, text(&out).as_str()), (422, r#"{"status":"error","message":"polis_err_topic_map_too_large"}"#));
        }
        let out = crate::dispatch(app.clone(), None, ask("before")).await;
        assert_eq!(out.status, 200);
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(body.reason, NoMapReason::NotStored);
        assert!(body.job_id.is_some());
        let out = crate::dispatch(app.clone(), None, ask("few")).await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(body.reason, NoMapReason::TooFewComments);
        // An earlier run's map is never served as this run's.
        let out = crate::dispatch(app.clone(), None, ask("carried")).await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(body.reason, NoMapReason::NotStored);
        // Stored rows that are not a map this route can serve: refused as
        // this run's map (500), never served and never Node's 404. A digest
        // of the right shape that is not the document's, a gzip that is not
        // the document, and a part naming another job are refused whatever
        // the client holds: with no ETag, with the stored one, and with `*`.
        let unreadable = r#"{"status":"error","message":"polis_err_topic_map_unreadable"}"#;
        for report in ["odd", "badsha", "nogz", "twice", "foreign", "zeros", "badgz", "otherdoc", "othergz", "badcrc", "badflag", "trailing", "badhcrc"] {
            for coding in ["gzip", "identity"] {
                for tag in [None, Some("*".to_owned()), Some(format!("\"{}\"", "0".repeat(64))), Some(format!("W/\"{}\"", map.sha256))] {
                    let mut headers = vec![("accept-encoding", coding)];
                    if let Some(tag) = &tag {
                        headers.push(("if-none-match", tag.as_str()));
                    }
                    let out = crate::dispatch(app.clone(), None, with(&format!("/api/v3/delphi/topicMap?report_id={report}"), &headers)).await;
                    assert_eq!((out.status, text(&out).as_str()), (500, unreadable), "{report} {coding} {tag:?}");
                }
            }
        }
        // A read slower than its statement bound is the route shedding its
        // load (503, try again), never "no such map".
        let started = std::time::Instant::now();
        let out = crate::dispatch(app.clone(), None, ask("slow")).await;
        assert_eq!((out.status, header(&out, "Retry-After")), (503, Some("1")), "{}", text(&out));
        assert_eq!(text(&out), r#"{"status":"error","message":"polis_err_topic_map_busy"}"#);
        assert!(started.elapsed() < DEADLINE, "the statement bound, not the deadline");
        // The oversized part never crossed the connection.
        assert!(app.delphi_topic_map.max_held() < MAX_PART_BYTES as usize);
    });
}

/// What a reader sees: the status, the body, and the headers that say which
/// run it is and how it may be cached.
fn seen(out: &Outgoing) -> (u16, String, [Option<String>; 6]) {
    let h = |name: &str| header(out, name).map(str::to_owned);
    (
        out.status,
        text(out),
        [
            h(contract::HEADER_JOB),
            h(contract::HEADER_SOURCE),
            h(contract::HEADER_SCOPE),
            h(contract::HEADER_SELECTION),
            h("Cache-Control"),
            h("Vary"),
        ],
    )
}

/// What a request carries in `Authorization`; the route reads none of it.
const CREDENTIALS: [Option<&str>; 4] = [
    None,
    Some("Basic abc"),
    Some("Bearer not-a-token"),
    Some("Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2ln"),
];

#[test]
fn every_run_of_the_report_is_read_with_the_report_id_alone() {
    let db = Db::new("public");
    let served_map = stored(document(4, "served"));
    let all_map = stored(document(6, "all"));
    let named_map = stored(document(7, "named"));
    let shadow_map = stored(document(8, "shadow"));
    let shadow_all_map = stored(document(9, "shadow-all"));
    let (named, later, running, foreign, all_job, removed, shadow_all, shadow_foreign) = {
        let mut c = db.connect();
        c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
            .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi",
            "participant_visible/1",
            Some(&map_family(ZID, &served_map)),
        );
        let all_job = served(
            &mut c,
            "test",
            ZID,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(ZID, &all_map)),
        );
        // A past run whose stored map has since been removed (to save
        // storage): its record still names the family, its batch no longer
        // holds it.
        let (removed, gone) = (uuid(0x8000), uuid(0xa000));
        run(
            &mut c,
            "test",
            &removed,
            ZID,
            "COMPLETED",
            "participant_visible/1",
            Some((&gone, &removed)),
        );
        let (named, artifact) = (uuid(0x8000), uuid(0xa000));
        run(
            &mut c,
            "test",
            &named,
            ZID,
            "COMPLETED",
            "participant_visible/1",
            Some((&artifact, &named)),
        );
        wire_at(
            &mut c,
            "test",
            &artifact,
            &map_family(ZID, &named_map),
            &named,
        );
        // A later run with the step off: its record lists the named run's
        // map, carried forward; it is not the later run's.
        let later = uuid(0x8000);
        run(
            &mut c,
            "test",
            &later,
            ZID,
            "COMPLETED",
            "participant_visible/1",
            Some((&artifact, &named)),
        );
        let running = uuid(0x8000);
        run(
            &mut c,
            "test",
            &running,
            ZID,
            "PROCESSING",
            "participant_visible/1",
            None,
        );
        let foreign = uuid(0x8000);
        run(
            &mut c,
            "test",
            &foreign,
            99,
            "COMPLETED",
            "participant_visible/1",
            None,
        );
        // The shadow's own runs of the same conversation, in its own env:
        // one under each of two comment rules.
        served(
            &mut c,
            "shadow-delphi-1",
            ZID,
            "delphi",
            "participant_visible/1",
            Some(&map_family(ZID, &shadow_map)),
        );
        let shadow_all = served(
            &mut c,
            "shadow-delphi-1",
            ZID,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(ZID, &shadow_all_map)),
        );
        // A shadow run of another conversation, with a map.
        let shadow_foreign = served(
            &mut c,
            "shadow-delphi-1",
            99,
            "delphi",
            "participant_visible/1",
            Some(&map_family(99, &stored(document(3, "other")))),
        );
        (
            named,
            later,
            running,
            foreign,
            all_job,
            removed,
            shadow_all,
            shadow_foreign,
        )
    };
    runtime().block_on(async {
        let mut app = app_on(&db);
        app.delphi_topic_map_shadow_env = Some("shadow-delphi-1".into());
        let app = Arc::new(app);
        let ask = |query: &str, credential: Option<&str>| {
            let url = format!("/api/v3/delphi/topicMap?report_id=r1{query}");
            match credential {
                Some(t) => with(&url, &[("authorization", t)]),
                None => with(&url, &[]),
            }
        };
        let public = (Some("no-cache".to_owned()), Some("Accept-Encoding".to_owned()));
        // (query, the map, its job, source, scope, comment rule)
        let maps: [(String, &Stored, &str, &str, &str, &str); 10] = [
            // The current map: the served side has one, so it is the served one.
            ("".into(), &served_map, "", "served", "delphi", "participant_visible/1"),
            ("&selection=all_comments".into(), &all_map, &all_job, "served", "delphi:all_comments", "all_comments/1"),
            (format!("&job_id={named}"), &named_map, &named, "served", "delphi", "participant_visible/1"),
            // A named run of another comment rule: as public as any other.
            (format!("&job_id={all_job}"), &all_map, &all_job, "served", "delphi", "all_comments/1"),
            // The shadow's runs, with no sign-in.
            ("&source=shadow".into(), &shadow_map, "", "shadow", "delphi", "participant_visible/1"),
            ("&source=shadow&selection=all_comments".into(), &shadow_all_map, &shadow_all, "shadow", "delphi:all_comments", "all_comments/1"),
            (format!("&source=shadow&job_id={shadow_all}"), &shadow_all_map, &shadow_all, "shadow", "delphi", "all_comments/1"),
            // A shadow job named without a source: the served side has no
            // such job, so the shadow's is read.
            (format!("&job_id={shadow_all}"), &shadow_all_map, &shadow_all, "shadow", "delphi", "all_comments/1"),
            ("&source=served".into(), &served_map, "", "served", "delphi", "participant_visible/1"),
            ("&source=served&selection=all_comments".into(), &all_map, &all_job, "served", "delphi:all_comments", "all_comments/1"),
        ];
        for (query, map, job, source, scope, selection) in &maps {
            let first = seen(&crate::dispatch(app.clone(), None, ask(query, None)).await);
            assert_eq!(first.0, 200, "{query}: {}", first.1);
            assert_eq!(&first.1, &map.document, "{query}");
            if !job.is_empty() {
                assert_eq!(first.2[0].as_deref(), Some(*job), "{query}");
            }
            assert_eq!(first.2[1].as_deref(), Some(*source), "{query}");
            assert_eq!(first.2[2].as_deref(), Some(*scope), "{query}");
            assert_eq!(first.2[3].as_deref(), Some(*selection), "{query}");
            assert_eq!((first.2[4].clone(), first.2[5].clone()), public, "{query}");
            // The same answer, byte for byte and header for header, whatever
            // the request says about who is asking.
            for credential in CREDENTIALS {
                let out = crate::dispatch(app.clone(), None, ask(query, credential)).await;
                assert_eq!(seen(&out), first, "{query} {credential:?}");
            }
        }
        // Refusals that are not about who is asking, as before.
        for (query, expected) in [
            // Another conversation's run is no run of this report's, on
            // either side and with or without a source.
            (format!("&job_id={foreign}"), 404),
            (format!("&source=served&job_id={foreign}"), 404),
            (format!("&source=shadow&job_id={shadow_foreign}"), 404),
            (format!("&job_id={shadow_foreign}"), 404),
            // A named side is read alone.
            (format!("&source=served&job_id={shadow_all}"), 404),
            (format!("&source=shadow&job_id={named}"), 404),
            ("&job_id=00000000-0000-4000-8000-00000000000F".into(), 404),
            ("&job_id=not-a-job".into(), 404),
        ] {
            for credential in CREDENTIALS {
                let out = crate::dispatch(app.clone(), None, ask(&query, credential)).await;
                assert_eq!(out.status, expected, "{query} {credential:?}: {}", text(&out));
                assert_eq!(text(&out), r#"{"status":"error","message":"Job not found"}"#);
                assert_eq!(header(&out, "Cache-Control"), Some("no-store"));
            }
        }
        let out = crate::dispatch(app.clone(), None, ask(&format!("&job_id={running}"), None)).await;
        assert_eq!(
            text(&out),
            format!(r#"{{"status":"success","message":"The Delphi run has not finished","report_id":"r1","job_id":"{running}","source":"served","scope":null,"reason":"run_not_ready"}}"#)
        );
        let out = crate::dispatch(app.clone(), None, ask(&format!("&job_id={later}"), None)).await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(
            (body.reason, body.job_id.as_deref(), body.source),
            (NoMapReason::NotStored, Some(later.as_str()), Source::Served)
        );
        // A past run whose map was removed answers as one that never stored
        // one: 200, `not_stored`, the served side's answer (the shadow has no
        // such job), for anyone.
        for credential in CREDENTIALS {
            let out = crate::dispatch(app.clone(), None, ask(&format!("&job_id={removed}"), credential)).await;
            assert_eq!(
                text(&out),
                format!(r#"{{"status":"success","message":"The Delphi run has no stored topic map","report_id":"r1","job_id":"{removed}","source":"served","scope":null,"reason":"not_stored"}}"#)
            );
        }
        // The shadow has no run under the third rule: said, not substituted.
        let out = crate::dispatch(app.clone(), None, ask("&source=shadow&selection=all_but_moderated_out", None)).await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(
            (body.reason, body.source, body.scope.as_deref()),
            (NoMapReason::NoRun, Source::Shadow, Some("delphi:all_but_moderated_out"))
        );
    });
}

#[test]
fn a_query_naming_no_source_reads_the_served_side_then_the_shadow() {
    let db = Db::new("sides");
    let shadow_map = stored(document(8, "shadow"));
    let shadow_all_map = stored(document(9, "shadow-all"));
    let served_map = stored(document(5, "served"));
    // 'shadow': the served side never stored a map (no run at all), the
    // shadow did, under two rules. 'before': the served run stored none (it
    // ran before runs stored maps), the shadow's did. 'few': the served run
    // stored its own no-map reason, which is its answer. 'none': neither
    // side has a run. 'served': both sides have a map.
    let (zs, zb, zf, zn, zv) = (ZID + 1, ZID + 2, ZID + 3, ZID + 4, ZID + 5);
    let (shadow_job, shadow_all, before_job, before_shadow, served_job) = {
        let mut c = db.connect();
        c.batch_execute(&format!(
            "INSERT INTO reports VALUES('shadow',{zs}),('before',{zb}),('few',{zf}),('none',{zn}),('served',{zv})"
        ))
        .unwrap();
        let p = "participant_visible/1";
        let shadow = "shadow-delphi-1";
        let shadow_job = served(
            &mut c,
            shadow,
            zs,
            "delphi",
            p,
            Some(&map_family(zs, &shadow_map)),
        );
        let shadow_all = served(
            &mut c,
            shadow,
            zs,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(zs, &shadow_all_map)),
        );
        let before_job = served(&mut c, "test", zb, "delphi", p, None);
        let before_shadow = served(
            &mut c,
            shadow,
            zb,
            "delphi",
            p,
            Some(&map_family(zb, &shadow_map)),
        );
        served(
            &mut c,
            "test",
            zf,
            "delphi",
            p,
            Some(&no_map_family(zf, "too_few_comments")),
        );
        served(
            &mut c,
            shadow,
            zf,
            "delphi",
            p,
            Some(&map_family(zf, &shadow_map)),
        );
        let served_job = served(
            &mut c,
            "test",
            zv,
            "delphi",
            p,
            Some(&map_family(zv, &served_map)),
        );
        served(
            &mut c,
            shadow,
            zv,
            "delphi",
            p,
            Some(&map_family(zv, &shadow_map)),
        );
        (
            shadow_job,
            shadow_all,
            before_job,
            before_shadow,
            served_job,
        )
    };
    runtime().block_on(async {
        let mut app = app_on(&db);
        app.delphi_topic_map_shadow_env = Some("shadow-delphi-1".into());
        let app = Arc::new(app);
        let get_ = |q: &str| crate::dispatch(app.clone(), None, with(&format!("/api/v3/delphi/topicMap?{q}"), &[]));
        // The report id alone: the shadow's current map under the
        // participants' rule, when the served side has none stored.
        let out = get_("report_id=shadow").await;
        assert_eq!(text(&out), shadow_map.document);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(shadow_job.as_str()));
        assert_eq!(header(&out, contract::HEADER_SOURCE), Some("shadow"));
        assert_eq!(header(&out, contract::HEADER_SCOPE), Some("delphi"));
        assert_eq!(header(&out, contract::HEADER_SELECTION), Some("participant_visible/1"));
        // The other rule is asked for by name, and read the same way.
        let out = get_("report_id=shadow&selection=all_comments").await;
        assert_eq!(text(&out), shadow_all_map.document);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(shadow_all.as_str()));
        assert_eq!(header(&out, contract::HEADER_SOURCE), Some("shadow"));
        assert_eq!(header(&out, contract::HEADER_SCOPE), Some("delphi:all_comments"));
        // A served run that stored no map: the shadow's.
        let out = get_("report_id=before").await;
        assert_eq!(text(&out), shadow_map.document);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(before_shadow.as_str()));
        // Named, the served run's own answer is kept.
        let out = get_(&format!("report_id=before&job_id={before_job}")).await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!((body.reason, body.source), (NoMapReason::NotStored, Source::Served));
        // `source=served` reads the served side alone, as before.
        let out = get_("report_id=before&source=served").await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(
            (body.reason, body.source, body.job_id.as_deref()),
            (NoMapReason::NotStored, Source::Served, Some(before_job.as_str()))
        );
        let out = get_("report_id=shadow&source=served").await;
        assert_eq!(
            text(&out),
            r#"{"status":"success","message":"No Delphi run found for this report","report_id":"shadow","job_id":null,"source":"served","scope":"delphi","reason":"no_run"}"#
        );
        // A reason the served run stored itself is the served side's answer.
        let out = get_("report_id=few").await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!((body.reason, body.source), (NoMapReason::TooFewComments, Source::Served));
        // Both sides with a map: the served one.
        let out = get_("report_id=served").await;
        assert_eq!(text(&out), served_map.document);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(served_job.as_str()));
        assert_eq!(header(&out, contract::HEADER_SOURCE), Some("served"));
        // Neither side has anything: the served side's answer, as before.
        let none = r#"{"status":"success","message":"No Delphi run found for this report","report_id":"none","job_id":null,"source":"served","scope":"delphi","reason":"no_run"}"#;
        assert_eq!(text(&get_("report_id=none").await), none);
        let out = get_("report_id=shadow&selection=all_but_moderated_out").await;
        let body: contract::NoMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(
            (body.reason, body.source, body.scope.as_deref()),
            (NoMapReason::NoRun, Source::Served, Some("delphi:all_but_moderated_out"))
        );
        // The shadow's map revalidates as any other: its own digest, 304.
        let etag = format!("W/\"{}\"", shadow_map.sha256);
        let out = crate::dispatch(
            app.clone(),
            None,
            with("/api/v3/delphi/topicMap?report_id=shadow", &[("if-none-match", etag.as_str())]),
        )
        .await;
        assert_eq!(out.status, 304);
        assert_eq!(header(&out, "ETag"), Some(etag.as_str()));
        // A deployment that reads no shadow answers a query naming no source
        // from the served side alone, exactly as before.
        let mut alone = app_on(&db);
        alone.delphi_topic_map_shadow_env = None;
        let alone = Arc::new(alone);
        let out = crate::dispatch(alone.clone(), None, with("/api/v3/delphi/topicMap?report_id=shadow", &[])).await;
        assert_eq!(
            text(&out),
            r#"{"status":"success","message":"No Delphi run found for this report","report_id":"shadow","job_id":null,"source":"served","scope":"delphi","reason":"no_run"}"#
        );
        let out = crate::dispatch(alone, None, with("/api/v3/delphi/topicMap?report_id=shadow&source=shadow", &[])).await;
        assert_eq!(out.status, 404);
        assert_eq!(text(&out), r#"{"status":"error","message":"polis_err_topic_map_no_source"}"#);
    });
}

#[test]
fn a_full_route_sheds_at_once_and_reads_again_when_a_place_frees() {
    let db = Db::new("places");
    let map = stored(document(50, "j"));
    {
        let mut c = db.connect();
        c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID})"))
            .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi",
            "participant_visible/1",
            Some(&map_family(ZID, &map)),
        );
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut app = app_on(&db);
        app.delphi_topic_map = State::new(2);
        let app = Arc::new(app);
        let state = app.delphi_topic_map.clone();
        let pool = app.delphi_topic_map_db.clone().unwrap();
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        // Two requests hold both places and both connections, inside their
        // reads; a third is refused at once and reads nothing.
        state.close_reads();
        let held: Vec<_> = (0..2)
            .map(|_| tokio::spawn(crate::dispatch(app.clone(), None, with(url, &[]))))
            .collect();
        let started = std::time::Instant::now();
        while state.in_flight() < 2 || pool.evidence.snapshot()[0] < 4 {
            tokio::time::sleep(Duration::from_millis(1)).await;
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the reads never started"
            );
        }
        let before = pool.evidence.snapshot();
        let t = std::time::Instant::now();
        let shed = crate::dispatch(app.clone(), None, with(url, &[])).await;
        let took = t.elapsed();
        assert_eq!(shed.status, 503);
        assert_eq!(header(&shed, "Retry-After"), Some("1"));
        assert_eq!(
            pool.evidence.snapshot()[0],
            before[0],
            "the shed request took no connection"
        );
        assert!(took < Duration::from_millis(50), "shed at once: {took:?}");
        state.open_reads();
        for task in held {
            assert_eq!(task.await.unwrap().status, 200);
        }
        assert_eq!(
            crate::dispatch(app.clone(), None, with(url, &[]))
                .await
                .status,
            200
        );
        assert_eq!(state.max_in_flight(), 2);
        assert!(state.busy() >= 1);
    });
}

struct Signer {
    key: EncodingKey,
}

impl Signer {
    fn new(app: &mut App) -> Self {
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        let jwks = serde_json::from_value(
            json!({"keys":[{"kty":"RSA","alg":"RS256","use":"sig","kid":"fixture",
            "n":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),
            "e":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rsa.e().to_vec())}]}),
        )
        .unwrap();
        app.read_oidc = Some(Arc::new(crate::hybrid_read::Oidc::for_tests(
            crate::owner::Verifier::new(jwks, "issuer", "audience").unwrap(),
            "namespace/",
        )));
        Self {
            key: EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
        }
    }
    fn bearer(&self, sub: &str) -> String {
        let now = (crate::clock::now_ms() / 1000.0) as u64;
        let mut h = Header::new(Algorithm::RS256);
        h.kid = Some("fixture".into());
        let claims = json!({"sub":sub,"iss":"issuer","aud":"audience","exp":now+300,"email":"fixture@example.invalid"});
        format!("Bearer {}", encode(&h, &claims, &self.key).unwrap())
    }
}

/// A moderator's change, made off the test's runtime (the client blocks).
fn moderate(db: &Db, sql: &str) {
    let (config, sql) = (db.config.clone(), sql.to_owned());
    std::thread::spawn(move || config.connect(NoTls).unwrap().batch_execute(&sql).unwrap())
        .join()
        .unwrap();
}

fn gunzipped(out: &Outgoing) -> Vec<u8> {
    super::gunzip(&bytes(out), MAX_PART_BYTES as usize).expect("one valid gzip member")
}

/// What every reader but a moderator receives, and what a moderator does,
/// as the comments' moderation is now; and the participants' map, which
/// holds no moderated-out comment, as stored.
#[test]
fn moderated_out_comments_are_bare_points_to_all_but_moderators() {
    let db = Db::new("moderated");
    let every = stored(small_map());
    // Comments 0 to 9: none of them is ever moderated out here.
    let participants = stored(document(10, "j"));
    {
        let mut c = db.connect();
        // Comment 14 was moderated out before the run, 10 is not yet
        // moderated, the rest are accepted; 99 is another conversation's.
        c.batch_execute(&format!(
            "INSERT INTO reports VALUES('r1',{ZID});
             INSERT INTO users VALUES(3,'owners'),(4,'others'),(6,'admins');
             INSERT INTO oidc_user_mappings VALUES(3,'owner'),(4,'stranger'),(6,'admin');
             INSERT INTO conversations VALUES({ZID},3),(99,4);
             INSERT INTO comments VALUES({ZID},10,0),({ZID},11,1),({ZID},12,1),({ZID},13,1),({ZID},14,-1),(99,11,-1);"
        ))
        .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(ZID, &every)),
        );
        served(
            &mut c,
            "test",
            ZID,
            "delphi",
            "participant_visible/1",
            Some(&map_family(ZID, &participants)),
        );
    }
    let mut app = app_on(&db);
    let signer = Signer::new(&mut app);
    app.legacy_admin_uids = vec![6];
    let (owner, stranger, admin) = (
        signer.bearer("owner"),
        signer.bearer("stranger"),
        signer.bearer("admin"),
    );
    runtime().block_on(async {
        let app = Arc::new(app);
        let all = "/api/v3/delphi/topicMap?report_id=r1&selection=all_comments";
        let stored_tag = format!("W/\"{}\"", every.sha256);
        let get_with = |url: &'static str, h: Vec<(&'static str, String)>| {
            let app = app.clone();
            async move {
                let headers: Vec<(&str, &str)> = h.iter().map(|(k, v)| (*k, v.as_str())).collect();
                // Boxed: the test's one future holds many requests.
                Box::pin(crate::dispatch(app, None, with(url, &headers))).await
            }
        };
        let gz = || vec![("accept-encoding", "gzip".to_string())];
        let reader_tag_now = |hidden: &[i64]| {
            format!(
                "W/\"{}\"",
                reader_tag(
                    &every.sha256,
                    &reader_form(app.delphi_topic_map.validator_key(), ZID, hidden)
                )
            )
        };

        // Anyone: comment 14 is a bare point, and its topic, which no other
        // comment is in, is not sent.
        let public = get_with(all, gz()).await;
        assert_eq!(public.status, 200, "{}", text(&public));
        let form = gunzipped(&public);
        let doc: contract::TopicMap = serde_json::from_slice(&form).unwrap();
        assert_eq!(
            doc.points.id,
            vec![Some(10), Some(11), Some(12), Some(13), None]
        );
        assert_eq!(doc.points.moderated_out, 1);
        assert_eq!(
            (doc.points.x[4], doc.points.y[4]),
            (-0.5, 0.4),
            "its position, as the run laid it out"
        );
        assert!(doc.points.topic.iter().all(|row| row[4] == -1));
        assert!(doc.topics.iter().all(|t| t.id != "0_2"));
        let raw = String::from_utf8(form.clone()).unwrap();
        assert!(
            !raw.contains("secret")
                && !raw.contains("\"0_2\"")
                && !doc.points.id.contains(&Some(14)),
            "{raw}"
        );
        assert_eq!(
            header(&public, "ETag"),
            Some(reader_tag_now(&[14]).as_str())
        );
        assert_ne!(header(&public, "ETag"), Some(stored_tag.as_str()));
        assert_eq!(header(&public, "Cache-Control"), Some("no-cache"));
        assert_eq!(header(&public, "Vary"), Some("Accept-Encoding"));
        assert_eq!(header(&public, "Content-Encoding"), Some("gzip"));
        // Without gzip: the same document.
        let plain = get_with(all, vec![]).await;
        assert_eq!(bytes(&plain), form);
        // A signed-in reader who does not moderate it, a token that does not
        // verify, and a header that is not a bearer token: the same answer.
        for credential in [
            stranger.clone(),
            "Bearer not.a.token".into(),
            "Basic dXNlcjpwYXNz".into(),
        ] {
            let out = get_with(
                all,
                vec![
                    ("accept-encoding", "gzip".into()),
                    ("authorization", credential.clone()),
                ],
            )
            .await;
            assert_eq!(out.status, 200, "{credential}");
            assert_eq!(gunzipped(&out), form, "{credential}");
            assert_eq!(header(&out, "ETag"), header(&public, "ETag"));
            assert_eq!(header(&out, "Cache-Control"), Some("no-cache"));
        }

        // A moderator (the owner) and a site administrator: the map as stored,
        // never kept by a cache.
        for credential in [owner.clone(), admin.clone()] {
            let out = get_with(
                all,
                vec![
                    ("accept-encoding", "gzip".into()),
                    ("authorization", credential),
                ],
            )
            .await;
            assert_eq!(out.status, 200);
            assert_eq!(bytes(&out), every.gzip, "the stored gzip, byte for byte");
            assert_eq!(header(&out, "ETag"), Some(stored_tag.as_str()));
            assert_eq!(header(&out, "Cache-Control"), Some("private, no-store"));
            assert_eq!(header(&out, "Vary"), Some("Authorization, Accept-Encoding"));
        }

        // A reader presenting the moderator's validator gets the reader's form,
        // never a 304 for bytes it may not have; its own validator is a 304.
        let out = get_with(
            all,
            vec![
                ("accept-encoding", "gzip".into()),
                ("if-none-match", stored_tag.clone()),
            ],
        )
        .await;
        assert_eq!(out.status, 200);
        assert_eq!(gunzipped(&out), form);
        let out = get_with(
            all,
            vec![("if-none-match", format!("\"{}\"", every.sha256))],
        )
        .await;
        assert_eq!((out.status, bytes(&out)), (200, form.clone()));
        let public_tag = header(&public, "ETag").unwrap().to_owned();
        let out = get_with(
            all,
            vec![
                ("accept-encoding", "gzip".into()),
                ("if-none-match", public_tag.clone()),
            ],
        )
        .await;
        assert_eq!(out.status, 304);
        assert!(bytes(&out).is_empty());
        // A moderator presenting a reader's validator gets the full map.
        let out = get_with(
            all,
            vec![
                ("accept-encoding", "gzip".into()),
                ("authorization", owner.clone()),
                ("if-none-match", public_tag.clone()),
            ],
        )
        .await;
        assert_eq!((out.status, bytes(&out)), (200, every.gzip.clone()));

        // Comment 12 is moderated out after the run: from the next read it is
        // a bare point, and the earlier validator no longer answers 304.
        moderate(
            &db,
            &format!("UPDATE comments SET mod=-1 WHERE zid={ZID} AND tid=12"),
        );
        let out = get_with(
            all,
            vec![
                ("accept-encoding", "gzip".into()),
                ("if-none-match", public_tag.clone()),
            ],
        )
        .await;
        assert_eq!(out.status, 200);
        let later: contract::TopicMap = serde_json::from_slice(&gunzipped(&out)).unwrap();
        assert_eq!(
            later.points.id,
            vec![Some(10), Some(11), Some(13), None, None]
        );
        assert_eq!(later.points.moderated_out, 2);
        assert_eq!(
            header(&out, "ETag"),
            Some(reader_tag_now(&[12, 14]).as_str())
        );
        // The moderator still receives everything.
        let out = get_with(
            all,
            vec![
                ("accept-encoding", "gzip".into()),
                ("authorization", owner.clone()),
            ],
        )
        .await;
        assert_eq!(bytes(&out), every.gzip);
        // Both moderated back in: whole again, the stored bytes and the stored
        // digest, for anyone.
        moderate(
            &db,
            &format!("UPDATE comments SET mod=1 WHERE zid={ZID} AND tid IN (12,14)"),
        );
        let out = get_with(
            all,
            vec![
                ("accept-encoding", "gzip".into()),
                ("if-none-match", public_tag.clone()),
            ],
        )
        .await;
        assert_eq!(out.status, 200);
        assert_eq!(bytes(&out), every.gzip);
        assert_eq!(header(&out, "ETag"), Some(stored_tag.as_str()));
        assert_eq!(header(&out, "Cache-Control"), Some("no-cache"));

        // The participants' map holds no moderated-out comment: byte for byte
        // what was stored, in both codings, while comment 14 is moderated out
        // and while nothing is.
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        let out = get_with(url, gz()).await;
        assert_eq!(bytes(&out), participants.gzip);
        assert_eq!(
            header(&out, "ETag"),
            Some(format!("W/\"{}\"", participants.sha256).as_str())
        );
        moderate(
            &db,
            &format!("UPDATE comments SET mod=-1 WHERE zid={ZID} AND tid=14"),
        );
        let out = get_with(url, gz()).await;
        assert_eq!(bytes(&out), participants.gzip);
        assert_eq!(text(&get_with(url, vec![]).await), participants.document);
        // Its validator then names the moderation too (the reader's form is
        // the stored bytes, but the route cannot know that before reading them).
        let tag = format!(
            "W/\"{}\"",
            reader_tag(
                &participants.sha256,
                &reader_form(app.delphi_topic_map.validator_key(), ZID, &[14]),
            )
        );
        assert_eq!(header(&out, "ETag"), Some(tag.as_str()));
        let out = get_with(
            url,
            vec![("accept-encoding", "gzip".into()), ("if-none-match", tag)],
        )
        .await;
        assert_eq!(out.status, 304);
        assert_eq!(
            app.delphi_topic_map.0.held.load(Ordering::SeqCst),
            0,
            "nothing is kept"
        );
    });
}

/// A map with one comment of each state: what a reader who is not a
/// moderator receives for each, as Node's participant list decides it
/// (`active`, `velocity`), except that a comment not yet moderated is shown.
#[test]
fn inactive_and_muted_comments_are_held_back_and_unmoderated_ones_are_not() {
    let db = Db::new("held_back");
    let every = stored(small_map());
    {
        let mut c = db.connect();
        // 10 inactive, 11 muted, 12 not yet moderated, 13 accepted, 14
        // accepted.
        c.batch_execute(&format!(
            "INSERT INTO reports VALUES('r1',{ZID});
             INSERT INTO conversations VALUES({ZID},3);
             INSERT INTO comments(zid,tid,mod,active,velocity) VALUES({ZID},10,1,false,1),
               ({ZID},11,1,true,0),({ZID},12,0,true,1),({ZID},13,1,true,1),({ZID},14,1,true,1);"
        ))
        .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(ZID, &every)),
        );
    }
    let app = Arc::new(app_on(&db));
    runtime().block_on(async {
        let out = crate::dispatch(
            app.clone(),
            None,
            with(
                "/api/v3/delphi/topicMap?report_id=r1&selection=all_comments",
                &[],
            ),
        )
        .await;
        assert_eq!(out.status, 200, "{}", text(&out));
        let doc: contract::TopicMap = serde_json::from_slice(&bytes(&out)).unwrap();
        assert_eq!(
            doc.points.id,
            vec![Some(12), Some(13), Some(14), None, None]
        );
        assert_eq!(doc.points.moderated_out, 2);
        let tag = header(&out, "ETag").unwrap().to_owned();
        let expected = reader_tag(
            &every.sha256,
            &reader_form(app.delphi_topic_map.validator_key(), ZID, &[10, 11]),
        );
        assert_eq!(tag, format!("W/\"{expected}\""));
    });
}

/// The route's login without `SELECT` on `comments`: the map is not sent,
/// and the answer is the 500 that names nothing, not the route shedding.
#[test]
fn a_login_that_may_not_read_comments_is_refused_whole() {
    let db = Db::new("no_grant");
    let every = stored(small_map());
    let role = format!("topic_map_no_comments_{}", std::process::id());
    {
        let mut c = db.connect();
        c.batch_execute(&format!(
            "INSERT INTO reports VALUES('r1',{ZID});
             INSERT INTO comments VALUES({ZID},14,-1);
             DROP ROLE IF EXISTS {role};
             CREATE ROLE {role} LOGIN;
             GRANT SELECT ON reports TO {role};"
        ))
        .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(ZID, &every)),
        );
    }
    let mut app = app_on(&db);
    let mut config = db.config.clone();
    config.user(&role);
    app.delphi_topic_map_db = Some(crate::db::Pool::new(
        Connector::Plain(Box::new(config)),
        pool_limits(),
    ));
    let app = Arc::new(app);
    runtime().block_on(async {
        let out = crate::dispatch(
            app.clone(),
            None,
            with(
                "/api/v3/delphi/topicMap?report_id=r1&selection=all_comments",
                &[],
            ),
        )
        .await;
        let body = text(&out);
        assert_eq!(out.status, 500, "{body}");
        assert!(body.contains(contract::UNREADABLE), "{body}");
        assert!(
            !body.contains("comments") && !body.contains("permission"),
            "{body}"
        );
        assert_eq!(app.delphi_topic_map.busy(), 0);
    });
    drop(app);
    db.connect()
        .batch_execute(&format!("DROP OWNED BY {role}; DROP ROLE {role};"))
        .unwrap();
}

/// A bearer token while the identity database does not answer: the route
/// sheds (503, try again), never treats the bearer as a reader who is not
/// signed in.
#[test]
fn a_bearer_while_the_identity_database_is_down_is_shed() {
    let db = Db::new("auth_down");
    let every = stored(small_map());
    {
        let mut c = db.connect();
        c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
            .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(ZID, &every)),
        );
    }
    let mut app = app_on(&db);
    let signer = Signer::new(&mut app);
    // Nothing listens on port 1.
    let mut down = postgres::Config::new();
    down.host("127.0.0.1")
        .port(1)
        .user("postgres")
        .dbname("absent")
        .connect_timeout(Duration::from_millis(50));
    app.delphi_topic_map_auth_db = Some(crate::db::Pool::new(
        Connector::Plain(Box::new(down)),
        auth_pool_limits(),
    ));
    let owner = signer.bearer("owner");
    let app = Arc::new(app);
    runtime().block_on(async {
        let out = crate::dispatch(
            app.clone(),
            None,
            with(
                "/api/v3/delphi/topicMap?report_id=r1&selection=all_comments",
                &[("authorization", owner.as_str())],
            ),
        )
        .await;
        assert_eq!(
            (out.status, header(&out, "Retry-After")),
            (503, Some("1")),
            "{}",
            text(&out)
        );
    });
}

/// A reader's form is made once per stored map and held-back set: the same
/// request again, with or without gzip, is the kept form, never a rewrite; a
/// moderator receives the map as stored, never the kept form, and adds none;
/// a comment moderated out makes another form at once (another ETag, its
/// point bare). A conversation that holds back more than a reader's form is
/// made for gives such a reader no map (422 `too_large`), and a moderator
/// the map.
#[test]
fn a_readers_form_is_made_once_per_held_back_set_and_bounded() {
    let db = Db::new("kept_forms");
    let every = stored(small_map());
    {
        let mut c = db.connect();
        c.batch_execute(&format!(
            "INSERT INTO reports VALUES('r1',{ZID});
             INSERT INTO users VALUES(3,'owners');
             INSERT INTO oidc_user_mappings VALUES(3,'owner');
             INSERT INTO conversations VALUES({ZID},3);
             INSERT INTO comments VALUES({ZID},10,0),({ZID},11,1),({ZID},12,1),({ZID},13,1),({ZID},14,-1);"
        ))
        .unwrap();
        served(
            &mut c,
            "test",
            ZID,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(ZID, &every)),
        );
    }
    let mut app = app_on(&db);
    let signer = Signer::new(&mut app);
    let owner = signer.bearer("owner");
    runtime().block_on(async {
        let app = Arc::new(app);
        let state = app.delphi_topic_map.clone();
        let all = "/api/v3/delphi/topicMap?report_id=r1&selection=all_comments";
        let get_with = |h: Vec<(&'static str, String)>| {
            let app = app.clone();
            async move {
                let headers: Vec<(&str, &str)> = h.iter().map(|(k, v)| (*k, v.as_str())).collect();
                Box::pin(crate::dispatch(app, None, with(all, &headers))).await
            }
        };
        let gz = || vec![("accept-encoding", "gzip".to_string())];
        let first = get_with(gz()).await;
        assert_eq!(first.status, 200, "{}", text(&first));
        assert_eq!((state.rewrites(), state.kept().0), (1, 1));
        let again = get_with(gz()).await;
        let plain = get_with(vec![]).await;
        assert_eq!(bytes(&again), bytes(&first));
        assert_eq!(header(&again, "ETag"), header(&first, "ETag"));
        assert_eq!(bytes(&plain), gunzipped(&first));
        assert_eq!(state.rewrites(), 1, "the kept form, gzip or not");
        let doc: contract::TopicMap = serde_json::from_slice(&gunzipped(&first)).unwrap();
        assert_eq!(doc.points.moderated_out, 1);
        // A moderator: the stored map, and nothing kept or made for it.
        let moderator = get_with(vec![
            ("accept-encoding", "gzip".into()),
            ("authorization", owner.clone()),
        ])
        .await;
        assert_eq!(moderator.status, 200, "{}", text(&moderator));
        assert_eq!(gunzipped(&moderator), every.document.as_bytes());
        assert_eq!((state.rewrites(), state.kept().0), (1, 1));
        // Comment 13 moderated out: the next request is another form.
        moderate(
            &db,
            &format!("UPDATE comments SET mod=-1 WHERE zid={ZID} AND tid=13"),
        );
        let changed = get_with(gz()).await;
        assert_eq!(changed.status, 200);
        assert_ne!(header(&changed, "ETag"), header(&first, "ETag"));
        let doc: contract::TopicMap = serde_json::from_slice(&gunzipped(&changed)).unwrap();
        assert_eq!(doc.points.moderated_out, 2);
        assert!(!doc.points.id.contains(&Some(13)));
        assert_eq!((state.rewrites(), state.kept().0), (2, 2));
        assert!(state.max_rewriting() <= crate::delphi_topic_map::MAX_REWRITES);
        // Past the bound: a reader gets no map, a moderator the map.
        moderate(
            &db,
            &format!(
                "INSERT INTO comments SELECT {ZID}, n, -1 FROM generate_series(1000, {}) n",
                999 + crate::delphi_topic_map::MAX_HELD_BACK
            ),
        );
        let refused = get_with(gz()).await;
        assert_eq!(refused.status, 422, "{}", text(&refused));
        assert!(text(&refused).contains("too_large"), "{}", text(&refused));
        assert_eq!(state.rewrites(), 2);
        let moderator = get_with(vec![("authorization", owner.clone())]).await;
        assert_eq!(moderator.status, 200, "{}", text(&moderator));
        assert_eq!(bytes(&moderator), every.document.as_bytes());
    });
}

/// A finished full pipeline run for the list: its job row (created at
/// `at`, its configuration naming `selection` and, when given, the model
/// its naming asked for), and a record whose families are the map family
/// the run produced with `map_rows` rows at `artifact` (none when `None`)
/// and whose manifest says the keyword fallback named its topics (what a
/// run that asked for a model stores when it had no key, was over its cap
/// or its call failed).
fn listed_run(
    c: &mut postgres::Client,
    env: &str,
    zid: i32,
    selection: &str,
    at: &str,
    map: Option<(i64, &str)>,
    naming: Option<&str>,
) -> String {
    let job = uuid(0x7000);
    let mut config = json!({"selection": selection});
    if let Some(model) = naming {
        config["naming"] = json!({"model": model});
    }
    c.execute(
        "INSERT INTO delphi_result_jobs VALUES($1,$2,$3,'COMPLETED',$4::text::jsonb,$5)",
        &[&env, &job, &zid.to_string(), &config.to_string(), &at],
    )
    .unwrap();
    let mut families = vec![];
    if let Some((rows, artifact)) = map {
        families.push(json!({"family": contract::FAMILY, "job_id": job,
            "artifact_id": artifact, "row_count": rows, "scope": "delphi"}));
    }
    let record = json!({"job_id": job, "zid": zid, "families": families,
        "manifest": {"inputs": {}, "models": {"topic": "keywords"}, "cost": {}}});
    c.execute(
        "INSERT INTO stand_in_runs VALUES($1,$2::text::uuid,$3::text::jsonb)",
        &[&env, &job, &record.to_string()],
    )
    .unwrap();
    job
}

fn listed(out: &Outgoing) -> contract::JobList {
    assert_eq!(out.status, 200, "{}", text(out));
    serde_json::from_slice(&bytes(out)).unwrap()
}

#[test]
fn a_report_lists_its_runs_with_maps_newest_first_on_both_sides() {
    let db = Db::new("list");
    let map = stored(document(500, "j"));
    let wire = map_family(ZID, &map);
    let (served_artifact, shadow_artifact) = (uuid(0xa200), uuid(0xa200));
    let mut c = db.connect();
    c.batch_execute(&format!(
        "INSERT INTO reports VALUES('r1',{ZID}),('r2',77),('none',78);
         INSERT INTO conversations VALUES({ZID},3);
         INSERT INTO comments VALUES({ZID},10,1),({ZID},11,1);"
    ))
    .unwrap();
    let pv = "participant_visible/1";
    let at = |day: u8| format!("2026-11-{day:02}T00:00:00.000000Z");
    // Served: what participants see (published, its map stored), every
    // comment (asked for a model, named by keywords), all but moderated
    // out, a run that stored
    // no map, a run that failed and a run that is not a full pipeline run.
    let a = listed_run(
        &mut c,
        "test",
        ZID,
        pv,
        &at(1),
        Some((4, &served_artifact)),
        None,
    );
    wire_at(&mut c, "test", &served_artifact, &wire, &a);
    publish(&mut c, "test", ZID, "delphi", &a, &served_artifact);
    let b = listed_run(
        &mut c,
        "test",
        ZID,
        "all_comments/1",
        &at(2),
        Some((3, &uuid(0xa300))),
        Some("claude-haiku-4-5-20251001"),
    );
    let m = listed_run(
        &mut c,
        "test",
        ZID,
        "all_but_moderated_out/1",
        &at(3),
        Some((4, &uuid(0xa300))),
        None,
    );
    let n = listed_run(
        &mut c,
        "test",
        ZID,
        pv,
        &at(4),
        Some((2, &uuid(0xa300))),
        None,
    );
    let failed = listed_run(
        &mut c,
        "test",
        ZID,
        pv,
        &at(6),
        Some((4, &uuid(0xa300))),
        None,
    );
    c.execute(
        "UPDATE delphi_result_jobs SET status='FAILED' WHERE job_id=$1",
        &[&failed],
    )
    .unwrap();
    let child = listed_run(&mut c, "test", ZID, pv, &at(8), None, None);
    c.execute(
        "UPDATE delphi_result_jobs SET job_type='umap' WHERE job_id=$1",
        &[&child],
    )
    .unwrap();
    // The shadow's: what participants see.
    let s = listed_run(
        &mut c,
        "shadow-test",
        ZID,
        pv,
        &at(5),
        Some((4, &shadow_artifact)),
        None,
    );
    // Another conversation's run, newer than all of them.
    listed_run(
        &mut c,
        "test",
        77,
        pv,
        &at(7),
        Some((4, &uuid(0xa300))),
        None,
    );
    runtime().block_on(async {
        let mut app = app_on(&db);
        app.delphi_topic_map_shadow_env = Some("shadow-test".into());
        let app = Arc::new(app);
        let url = "/api/v3/delphi/topicMap?report_id=r1&list=jobs";
        let out = crate::dispatch(app.clone(), None, with(url, &[])).await;
        let body = text(&out);
        println!("list: {body}");
        let list = listed(&out);
        assert_eq!(list.report_id, "r1");
        let ids: Vec<_> = list.jobs.iter().map(|j| j.job_id.as_str()).collect();
        assert_eq!(
            ids,
            [s.as_str(), n.as_str(), m.as_str(), b.as_str(), a.as_str()]
        );
        let words: Vec<_> = list
            .jobs
            .iter()
            .map(|j| (j.source.word(), j.selection.map(Selection::word)))
            .collect();
        assert_eq!(
            words,
            [
                ("shadow", Some("participant_visible")),
                ("served", Some("participant_visible")),
                ("served", Some("all_but_moderated_out")),
                ("served", Some("all_comments")),
                ("served", Some("participant_visible"))
            ]
        );
        let points: Vec<_> = list.jobs.iter().map(|j| j.points).collect();
        assert!(points.iter().all(Option::is_none), "{points:?}");
        assert!(list.jobs.iter().all(|j| j.levels.is_none()));
        let names: Vec<_> = list
            .jobs
            .iter()
            .map(|j| (j.names.by, j.names.model.as_deref()))
            .collect();
        assert_eq!(
            names,
            [
                (contract::NamedBy::Keywords, None),
                (contract::NamedBy::Keywords, None),
                (contract::NamedBy::Keywords, None),
                (contract::NamedBy::Keywords, None),
                (contract::NamedBy::Keywords, None)
            ]
        );
        // The run that asked for a model and stored the keyword fallback is
        // not reported as named by the model it asked for: the request is
        // nowhere in the answer.
        assert!(!body.contains("claude-haiku"), "{body}");
        assert!(!body.contains("\"model\":\""), "{body}");
        assert_eq!(
            list.jobs[4].created_at.as_deref(),
            Some("2026-11-01T00:00:00.000000Z")
        );
        // `current` is the run the read with the report id alone answers.
        let current: Vec<_> = list
            .jobs
            .iter()
            .filter(|j| j.current)
            .map(|j| j.job_id.clone())
            .collect();
        assert_eq!(current, std::slice::from_ref(&a));
        let bare = crate::dispatch(
            app.clone(),
            None,
            with("/api/v3/delphi/topicMap?report_id=r1", &[]),
        )
        .await;
        assert_eq!(bare.status, 200);
        assert_eq!(header(&bare, contract::HEADER_JOB), Some(a.as_str()));
        // One side or one rule only; the shadow's side has no served pointer.
        let out = crate::dispatch(
            app.clone(),
            None,
            with(&format!("{url}&source=shadow"), &[]),
        )
        .await;
        let shadow = listed(&out);
        assert_eq!(
            shadow
                .jobs
                .iter()
                .map(|j| (j.job_id.as_str(), j.current))
                .collect::<Vec<_>>(),
            [(s.as_str(), false)]
        );
        let out = crate::dispatch(
            app.clone(),
            None,
            with(&format!("{url}&selection=all_comments"), &[]),
        )
        .await;
        let rule = listed(&out);
        assert_eq!(
            rule.jobs
                .iter()
                .map(|j| (j.job_id.as_str(), j.current))
                .collect::<Vec<_>>(),
            [(b.as_str(), false)]
        );
        // Moderating a comment out changes nothing in the list, byte for byte.
        moderate(
            &db,
            &format!("UPDATE comments SET mod=-1 WHERE zid={ZID} AND tid=10"),
        );
        let again = crate::dispatch(app.clone(), None, with(url, &[])).await;
        assert_eq!(text(&again), body);
        // A report whose conversation has no run: an empty list.
        let out = crate::dispatch(
            app.clone(),
            None,
            with("/api/v3/delphi/topicMap?report_id=none&list=jobs", &[]),
        )
        .await;
        assert_eq!(text(&out), r#"{"report_id":"none","jobs":[]}"#);
        // The other conversation's report lists its own run only.
        let out = crate::dispatch(
            app.clone(),
            None,
            with("/api/v3/delphi/topicMap?report_id=r2&list=jobs", &[]),
        )
        .await;
        let other = listed(&out);
        assert_eq!(other.jobs.len(), 1);
        assert!(
            other
                .jobs
                .iter()
                .all(|j| ![&a, &b, &m, &n, &s].contains(&&j.job_id))
        );
        // A list names runs: with `job_id` it is 400, and a `list` this route
        // does not know is 400 as an unknown `source` is.
        for (q, key) in [
            (format!("{url}&job_id={a}"), "list"),
            (
                "/api/v3/delphi/topicMap?report_id=r1&list=topics".into(),
                "list",
            ),
            (
                "/api/v3/delphi/topicMap?report_id=r1&source=elsewhere".into(),
                "source",
            ),
        ] {
            let out = crate::dispatch(app.clone(), None, with(&q, &[])).await;
            assert_eq!(out.status, 400, "{q}");
            let refusal: contract::Refusal = serde_json::from_slice(&bytes(&out)).unwrap();
            assert_eq!(refusal.parameter.as_deref(), Some(key));
        }
        // An unknown report is the map read's 404.
        let out = crate::dispatch(
            app.clone(),
            None,
            with("/api/v3/delphi/topicMap?report_id=nope&list=jobs", &[]),
        )
        .await;
        assert_eq!(out.status, 404);
    });
}

#[test]
fn a_list_names_the_newest_fifty_runs() {
    let db = Db::new("list_cap");
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    let jobs: Vec<String> = (0..60)
        .map(|i| {
            listed_run(
                &mut c,
                "test",
                ZID,
                "participant_visible/1",
                &format!("2026-10-{:02}T00:00:{i:02}.000000Z", 1 + i % 28),
                Some((4, &uuid(0xa400))),
                None,
            )
        })
        .collect();
    let mut newest: Vec<(String, String)> = jobs
        .iter()
        .enumerate()
        .map(|(i, j)| {
            (
                format!("2026-10-{:02}T00:00:{i:02}.000000Z", 1 + i % 28),
                j.clone(),
            )
        })
        .collect();
    newest.sort();
    newest.reverse();
    runtime().block_on(async {
        let app = Arc::new(app_on(&db));
        let out = crate::dispatch(
            app,
            None,
            with("/api/v3/delphi/topicMap?report_id=r1&list=jobs", &[]),
        )
        .await;
        let list = listed(&out);
        assert_eq!(list.jobs.len(), contract::MAX_LISTED);
        let ids: Vec<_> = list.jobs.iter().map(|j| j.job_id.clone()).collect();
        let expected: Vec<_> = newest
            .iter()
            .take(contract::MAX_LISTED)
            .map(|(_, j)| j.clone())
            .collect();
        assert_eq!(ids, expected);
        // No pointer is served: no run is current.
        assert!(list.jobs.iter().all(|j| !j.current));
    });
}

/// However many runs the conversation has, the list is the same two
/// statements and calls the run record once per side with a served pointer
/// (here one), never once per run: 1, 50 and 2,000 finished runs, the
/// oldest of them served with its map. The whole request's time (the median
/// of 21) is printed for each. Then each run record is made to take 50 ms
/// (the route's transaction is read-only, so a call is shown by its time,
/// not counted): the list of 2,000 still answers at once, where a call per
/// listed run (50 of them) would pass the statement's 2 s timeout.
#[test]
fn a_list_reads_no_run_record_per_run_however_many_runs_there_are() {
    let db = Db::new("list_many");
    let map = stored(document(50, "j"));
    let wire = map_family(ZID, &map);
    let artifact = uuid(0xa500);
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    let oldest = listed_run(
        &mut c,
        "test",
        ZID,
        "participant_visible/1",
        "2026-01-01T00:00:00.000000Z",
        Some((4, &artifact)),
        None,
    );
    wire_at(&mut c, "test", &artifact, &wire, &oldest);
    publish(&mut c, "test", ZID, "delphi", &oldest, &artifact);
    const URL: &str = "/api/v3/delphi/topicMap?report_id=r1&list=jobs";
    let mut have = 1;
    for runs in [1usize, 50, 2000] {
        if runs > have {
            c.execute(
                "INSERT INTO delphi_result_jobs(env, job_id, conversation_id, status, job_config, created_at) \
                 SELECT 'test', '00000000-0000-4000-9000-'||lpad(g::text,12,'0'), $1, 'COMPLETED', \
                  '{\"selection\":\"participant_visible/1\"}', \
                  to_char(timestamp '2026-02-01' + g * interval '1 minute','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') \
                 FROM generate_series($2::int, $3::int) g",
                &[&ZID.to_string(), &(have as i32), &(runs as i32 - 1)],
            )
            .unwrap();
            have = runs;
        }
        runtime().block_on(async {
            let app = Arc::new(app_on(&db));
            let mut took = Vec::new();
            for _ in 0..21 {
                let start = std::time::Instant::now();
                let out = crate::dispatch(app.clone(), None, with(URL, &[])).await;
                took.push(start.elapsed());
                let list = listed(&out);
                assert_eq!(list.jobs.len(), runs.min(contract::MAX_LISTED));
                // The served run is current while it is among the listed.
                let current = list.jobs.iter().filter(|j| j.current).count();
                assert_eq!(current, usize::from(runs <= contract::MAX_LISTED));
                assert!(
                    list.jobs
                        .windows(2)
                        .all(|w| w[0].created_at >= w[1].created_at)
                );
            }
            took.sort();
            println!(
                "list of {runs} runs: whole request median {:?}, max {:?}",
                took[took.len() / 2],
                took[took.len() - 1]
            );
        });
    }
    c.batch_execute(
        "CREATE OR REPLACE FUNCTION pd_run_record(p_env text, p_job uuid) RETURNS jsonb
           LANGUAGE sql VOLATILE AS
           $$ SELECT record FROM stand_in_runs, LATERAL (SELECT pg_sleep(0.05)) z
              WHERE env=p_env AND job_id=p_job $$;",
    )
    .unwrap();
    runtime().block_on(async {
        let app = Arc::new(app_on(&db));
        let start = std::time::Instant::now();
        let out = crate::dispatch(app, None, with(URL, &[])).await;
        let took = start.elapsed();
        println!("list of 2000 runs, each run record 50 ms: {took:?}");
        assert_eq!(listed(&out).jobs.len(), contract::MAX_LISTED);
        assert!(took < Duration::from_secs(1), "{took:?}");
    });
}

/// A deployment whose served Delphi is not on Postgres reads the shadow's
/// runs alone: every request answers as it would where the served env has
/// nothing stored, and a request naming the served side alone answers what
/// "no map stored" answers.
#[test]
fn a_shadow_only_route_answers_as_a_served_env_with_nothing_stored() {
    let db = Db::new("shadowonly");
    let shadow_map = stored(document(8, "shadow"));
    let shadow_all_map = stored(document(9, "shadow-all"));
    let (zs, zn) = (ZID + 1, ZID + 2);
    let shadow = "shadow-delphi-1";
    let (shadow_job, shadow_all) = {
        let mut c = db.connect();
        c.batch_execute(&format!(
            "INSERT INTO reports VALUES('shadow',{zs}),('none',{zn})"
        ))
        .unwrap();
        let shadow_job = served(
            &mut c,
            shadow,
            zs,
            "delphi",
            "participant_visible/1",
            Some(&map_family(zs, &shadow_map)),
        );
        let shadow_all = served(
            &mut c,
            shadow,
            zs,
            "delphi:all_comments",
            "all_comments/1",
            Some(&map_family(zs, &shadow_all_map)),
        );
        (shadow_job, shadow_all)
    };
    runtime().block_on(async {
        // The shadow-only route, and a served route whose env has nothing
        // stored: the same answers to every request.
        let mut only = app_on(&db);
        only.delphi_topic_map_env = String::new();
        only.delphi_topic_map_shadow_env = Some(shadow.into());
        let only = Arc::new(only);
        let mut empty = app_on(&db);
        empty.delphi_topic_map_env = "empty".into();
        empty.delphi_topic_map_shadow_env = Some(shadow.into());
        let empty = Arc::new(empty);
        let ask = |app: &Arc<App>, q: &str| {
            crate::dispatch(app.clone(), None, with(&format!("/api/v3/delphi/topicMap?{q}"), &[]))
        };
        let queries = [
            "report_id=shadow".to_owned(),
            "report_id=shadow&selection=all_comments".to_owned(),
            "report_id=shadow&selection=all_but_moderated_out".to_owned(),
            "report_id=shadow&source=shadow".to_owned(),
            "report_id=shadow&source=served".to_owned(),
            format!("report_id=shadow&job_id={shadow_job}"),
            format!("report_id=shadow&job_id={shadow_all}&source=shadow"),
            format!("report_id=shadow&job_id={shadow_job}&source=served"),
            "report_id=shadow&list=jobs".to_owned(),
            "report_id=shadow&list=jobs&source=served".to_owned(),
            "report_id=shadow&list=jobs&source=shadow".to_owned(),
            "report_id=none".to_owned(),
            "report_id=none&list=jobs".to_owned(),
            "report_id=nope".to_owned(),
        ];
        for q in &queries {
            let (a, b) = (ask(&only, q).await, ask(&empty, q).await);
            assert_eq!((a.status, text(&a)), (b.status, text(&b)), "{q}");
            for h in [contract::HEADER_JOB, contract::HEADER_SOURCE, contract::HEADER_SCOPE] {
                assert_eq!(header(&a, h), header(&b, h), "{q} {h}");
            }
        }
        // What those answers are.
        let out = ask(&only, "report_id=shadow").await;
        assert_eq!(text(&out), shadow_map.document);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(shadow_job.as_str()));
        assert_eq!(header(&out, contract::HEADER_SOURCE), Some("shadow"));
        let out = ask(&only, "report_id=shadow&selection=all_comments").await;
        assert_eq!(text(&out), shadow_all_map.document);
        let out = ask(&only, &format!("report_id=shadow&job_id={shadow_job}")).await;
        assert_eq!(text(&out), shadow_map.document);
        let out = ask(&only, "report_id=shadow&source=shadow").await;
        assert_eq!(text(&out), shadow_map.document);
        let no_run = |report: &str| {
            format!(
                r#"{{"status":"success","message":"No Delphi run found for this report","report_id":"{report}","job_id":null,"source":"served","scope":"delphi","reason":"no_run"}}"#
            )
        };
        assert_eq!(text(&ask(&only, "report_id=shadow&source=served").await), no_run("shadow"));
        assert_eq!(text(&ask(&only, "report_id=none").await), no_run("none"));
        let out = ask(&only, &format!("report_id=shadow&job_id={shadow_job}&source=served")).await;
        assert_eq!(out.status, 404, "{}", text(&out));
        let jobs = listed(&ask(&only, "report_id=shadow&list=jobs").await).jobs;
        assert!(jobs.iter().all(|j| j.source == Source::Shadow));
        let mut ids: Vec<_> = jobs.iter().map(|j| j.job_id.clone()).collect();
        ids.sort();
        let mut want = vec![shadow_job.clone(), shadow_all.clone()];
        want.sort();
        assert_eq!(ids, want);
        assert!(jobs.iter().any(|j| j.current && j.job_id == shadow_job));
        assert!(listed(&ask(&only, "report_id=shadow&list=jobs&source=served").await).jobs.is_empty());
    });
}

/// A derived topic map job made from `source`, as its job row, its record
/// and, once it has finished, its own publication (`derived:<key>`) at a map
/// family whose rows name it (`wire`); `from` is the run its specification
/// names, `zid` the conversation its row is in.
fn derived(
    c: &mut postgres::Client,
    zid: i32,
    source: &str,
    from: &str,
    status: &str,
    wire: Option<(&str, i64)>,
) -> String {
    let (job, artifact) = (uuid(0x5000), uuid(0x5a00));
    let key = derived_key("test", source);
    let config = json!({"derived": {"schema": "polis-derived/1", "key": key,
        "operation": "topic_map", "version": 1, "source": {"job_id": from}},
        "result_backend": "postgres", "result_scope": format!("derived:{key}")});
    c.execute(
        "INSERT INTO delphi_result_jobs(env, job_id, conversation_id, status, job_config, job_type) \
         VALUES('test',$1,$2,$3,$4::text::jsonb,'derived')",
        &[&job, &zid.to_string(), &status, &config.to_string()],
    )
    .unwrap();
    // Its address, as admission records it for good.
    c.execute(
        "INSERT INTO delphi_job_aliases VALUES('derived/1:'||$1,$2::text::uuid,'derived')",
        &[&key, &job],
    )
    .unwrap();
    let families: Vec<_> = wire
        .map(|(_, rows)| {
            json!({"family": contract::FAMILY, "artifact_id": artifact, "job_id": job,
                "row_count": rows, "scope": format!("derived:{key}")})
        })
        .into_iter()
        .collect();
    c.execute(
        "INSERT INTO stand_in_runs VALUES('test',$1::text::uuid,$2::text::jsonb)",
        &[
            &job,
            &json!({"job_id": job, "zid": zid, "families": families}).to_string(),
        ],
    )
    .unwrap();
    if let Some((wire, _)) = wire {
        wire_at(c, "test", &artifact, wire, &job);
        publish(c, "test", zid, &format!("derived:{key}"), &job, &artifact);
    }
    job
}

fn no_map_body(out: &Outgoing) -> contract::NoMap {
    assert_eq!(out.status, 200, "{}", text(out));
    serde_json::from_slice(&bytes(out)).unwrap()
}

#[test]
fn a_run_without_its_own_map_is_served_the_map_its_derived_job_made() {
    let db = Db::new("derived");
    let map = stored(document(40, "j"));
    let own = stored(document(30, "k"));
    let p = "participant_visible/1";
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    // A replaced run (no longer served), then the current one; neither stored
    // a map; a derived job made each one's.
    let old = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-01-01T00:00:00.000000Z",
        None,
        None,
    );
    let current = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-02-01T00:00:00.000000Z",
        None,
        None,
    );
    publish(&mut c, "test", ZID, "delphi", &current, &uuid(0xa000));
    let wire = map_family(ZID, &map);
    let by_current = derived(
        &mut c,
        ZID,
        &current,
        &current,
        "COMPLETED",
        Some((&wire, 3)),
    );
    let by_old = derived(&mut c, ZID, &old, &old, "COMPLETED", Some((&wire, 3)));
    // A run that stored its own map: sent as before, no derived header.
    let with_own = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2025-12-01T00:00:00.000000Z",
        Some((3, "00000000-0000-4000-a777-000000000001")),
        None,
    );
    wire_at(
        &mut c,
        "test",
        "00000000-0000-4000-a777-000000000001",
        &map_family(ZID, &own),
        &with_own,
    );
    // A derived family whose rows name the run, not the job that stored it.
    let lying = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2025-11-01T00:00:00.000000Z",
        None,
        None,
    );
    let by_lying = derived(&mut c, ZID, &lying, &lying, "COMPLETED", None);
    let artifact = uuid(0x5b00);
    wire_at(&mut c, "test", &artifact, &wire, &lying);
    let key = derived_key("test", &lying);
    publish(
        &mut c,
        "test",
        ZID,
        &format!("derived:{key}"),
        &by_lying,
        &artifact,
    );
    // The key's job, but its specification names another run.
    let crossed = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2025-10-01T00:00:00.000000Z",
        None,
        None,
    );
    derived(&mut c, ZID, &crossed, &old, "COMPLETED", Some((&wire, 3)));
    // Another conversation's row for this run's key is no job of this report's.
    let foreign = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2025-09-01T00:00:00.000000Z",
        None,
        None,
    );
    derived(
        &mut c,
        ZID + 1,
        &foreign,
        &foreign,
        "COMPLETED",
        Some((&wire, 3)),
    );
    runtime().block_on(async {
        let app = Arc::new(app_on(&db));
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        // The current map: the derived job's stored bytes, as the run's.
        let out =
            crate::dispatch(app.clone(), None, with(url, &[("accept-encoding", "gzip")])).await;
        assert_eq!(out.status, 200, "{}", text(&out));
        assert_eq!(bytes(&out), map.gzip);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(current.as_str()));
        assert_eq!(
            header(&out, contract::HEADER_MADE_BY),
            Some(by_current.as_str())
        );
        assert_eq!(header(&out, contract::HEADER_SCOPE), Some("delphi"));
        assert_eq!(header(&out, contract::HEADER_SELECTION), Some(p));
        let etag = format!("W/\"{}\"", map.sha256);
        assert_eq!(header(&out, "ETag"), Some(etag.as_str()));
        let out = crate::dispatch(
            app.clone(),
            None,
            with(
                url,
                &[("accept-encoding", "gzip"), ("if-none-match", &etag)],
            ),
        )
        .await;
        assert_eq!(out.status, 304);
        assert_eq!(
            header(&out, contract::HEADER_MADE_BY),
            Some(by_current.as_str())
        );
        // The replaced run, by its own id.
        let out =
            crate::dispatch(app.clone(), None, with(&format!("{url}&job_id={old}"), &[])).await;
        assert_eq!(text(&out), map.document);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(old.as_str()));
        assert_eq!(
            header(&out, contract::HEADER_MADE_BY),
            Some(by_old.as_str())
        );
        // A run with its own map: its bytes, and no derived header.
        let out = crate::dispatch(
            app.clone(),
            None,
            with(&format!("{url}&job_id={with_own}"), &[]),
        )
        .await;
        assert_eq!(text(&out), own.document);
        assert_eq!(header(&out, contract::HEADER_JOB), Some(with_own.as_str()));
        assert_eq!(header(&out, contract::HEADER_MADE_BY), None);
        // Rows that name another job, or a job made from another run: 500.
        for job in [&lying, &crossed] {
            let out =
                crate::dispatch(app.clone(), None, with(&format!("{url}&job_id={job}"), &[])).await;
            assert_eq!(out.status, 500, "{job}: {}", text(&out));
        }
        // Another conversation's job is not found for this run.
        let out = crate::dispatch(
            app.clone(),
            None,
            with(&format!("{url}&job_id={foreign}"), &[]),
        )
        .await;
        let body = no_map_body(&out);
        assert_eq!(body.reason, NoMapReason::NotStored);
        assert_eq!(body.map_job_id, None);
        assert!(!text(&out).contains("map_job_id"));
        // An unknown rule is refused as before.
        let out = crate::dispatch(
            app.clone(),
            None,
            with(&format!("{url}&selection=bogus"), &[]),
        )
        .await;
        assert_eq!(out.status, 400);
        // The list: runs only, the current one marked, each derived map named.
        let list = listed(
            &crate::dispatch(app.clone(), None, with(&format!("{url}&list=jobs"), &[])).await,
        );
        let ids: Vec<&str> = list.jobs.iter().map(|j| j.job_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                current.as_str(),
                old.as_str(),
                with_own.as_str(),
                lying.as_str(),
                crossed.as_str(),
                foreign.as_str()
            ]
        );
        assert!(
            !ids.contains(&by_current.as_str()),
            "a derived job is not a run"
        );
        let marked: Vec<_> = list
            .jobs
            .iter()
            .map(|j| (j.current, j.map.clone()))
            .collect();
        let made = |job: &str| {
            Some(contract::ListedMap {
                job_id: job.into(),
                status: contract::MapStatus::Stored,
            })
        };
        assert_eq!(marked[0], (true, made(&by_current)));
        assert_eq!(marked[1], (false, made(&by_old)));
        assert_eq!(marked[2], (false, None));
        assert_eq!(marked[3], (false, made(&by_lying)));
        assert_eq!(marked[5], (false, None));
    });
}

#[test]
fn a_derived_map_not_yet_made_or_never_made_says_so() {
    let db = Db::new("derived_states");
    let map = stored(document(20, "j"));
    let p = "participant_visible/1";
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    let current = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-02-01T00:00:00.000000Z",
        None,
        None,
    );
    publish(&mut c, "test", ZID, "delphi", &current, &uuid(0xa000));
    let waiting = derived(&mut c, ZID, &current, &current, "QUEUED", None);
    let few = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-01-03T00:00:00.000000Z",
        None,
        None,
    );
    let no_map = no_map_family(ZID, "too_few_comments");
    let by_few = derived(&mut c, ZID, &few, &few, "COMPLETED", Some((&no_map, 1)));
    let dead = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-01-02T00:00:00.000000Z",
        None,
        None,
    );
    let by_dead = derived(&mut c, ZID, &dead, &dead, "FAILED", None);
    let corrupt = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-01-01T00:00:00.000000Z",
        None,
        None,
    );
    let bad = Stored {
        sha256: "0".repeat(64),
        ..stored(document(20, "j"))
    };
    derived(
        &mut c,
        ZID,
        &corrupt,
        &corrupt,
        "COMPLETED",
        Some((&map_family(ZID, &bad), 3)),
    );
    // The shadow has a map: a served run whose map is being made is not
    // nothing stored, so the shadow's is not read.
    served(
        &mut c,
        "shadow",
        ZID,
        "delphi",
        p,
        Some(&map_family(ZID, &map)),
    );
    runtime().block_on(async {
        let mut app = app_on(&db);
        app.delphi_topic_map_shadow_env = Some("shadow".into());
        let app = Arc::new(app);
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        let out = crate::dispatch(app.clone(), None, with(url, &[])).await;
        let body = no_map_body(&out);
        assert_eq!(body.reason, NoMapReason::MapPending);
        assert_eq!(body.job_id.as_deref(), Some(current.as_str()));
        assert_eq!(body.map_job_id.as_deref(), Some(waiting.as_str()));
        assert_eq!(body.source, Source::Served);
        let out =
            crate::dispatch(app.clone(), None, with(&format!("{url}&job_id={few}"), &[])).await;
        let body = no_map_body(&out);
        assert_eq!(body.reason, NoMapReason::TooFewComments);
        assert_eq!(body.map_job_id.as_deref(), Some(by_few.as_str()));
        let out = crate::dispatch(
            app.clone(),
            None,
            with(&format!("{url}&job_id={dead}&source=served"), &[]),
        )
        .await;
        let body = no_map_body(&out);
        assert_eq!(body.reason, NoMapReason::MapFailed);
        assert_eq!(body.map_job_id.as_deref(), Some(by_dead.as_str()));
        let out = crate::dispatch(
            app.clone(),
            None,
            with(&format!("{url}&job_id={corrupt}&source=served"), &[]),
        )
        .await;
        assert_eq!(out.status, 500, "{}", text(&out));
        // The list agrees: nothing is current on the served side, and the
        // shadow's run is not current either, since the served side answers.
        let list = listed(
            &crate::dispatch(app.clone(), None, with(&format!("{url}&list=jobs"), &[])).await,
        );
        assert!(list.jobs.iter().all(|j| !j.current), "{list:?}");
        let status = |job: &str| {
            list.jobs
                .iter()
                .find(|j| j.job_id == job)
                .and_then(|j| j.map.as_ref())
                .map(|m| m.status)
        };
        assert_eq!(status(&current), Some(contract::MapStatus::Pending));
        assert_eq!(status(&few), Some(contract::MapStatus::Stored));
        assert_eq!(status(&dead), Some(contract::MapStatus::Failed));
    });
}

#[test]
fn review_derived_moderation_and_replacement() {
    let db = Db::new("review_moderation");
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID}); INSERT INTO comments(zid,tid,mod) VALUES({ZID},14,-1);")).unwrap();
    let map = stored(small_map());
    let wire = map_family(ZID, &map);
    let x = listed_run(
        &mut c,
        "test",
        ZID,
        "all_comments/1",
        "2026-01-01T00:00:00.000000Z",
        None,
        None,
    );
    publish(
        &mut c,
        "test",
        ZID,
        "delphi:all_comments",
        &x,
        &uuid(0xa000),
    );
    let y = derived(&mut c, ZID, &x, &x, "COMPLETED", Some((&wire, 3)));
    let own_art = uuid(0xb000);
    let own = listed_run(
        &mut c,
        "test",
        ZID,
        "all_comments/1",
        "2025-01-01T00:00:00.000000Z",
        Some((3, &own_art)),
        None,
    );
    wire_at(&mut c, "test", &own_art, &wire, &own);
    runtime().block_on(async {
        let app=Arc::new(app_on(&db));
        let url=format!("/api/v3/delphi/topicMap?report_id=r1&job_id={x}");
        let own_url=format!("/api/v3/delphi/topicMap?report_id=r1&job_id={own}");
        for gz in [false,true] {
            let headers=if gz {vec![("accept-encoding","gzip")]} else {vec![]};
            let a=crate::dispatch(app.clone(),None,with(&url,&headers)).await;
            let b=crate::dispatch(app.clone(),None,with(&own_url,&headers)).await;
            assert_eq!(a.status,200); assert_eq!(bytes(&a),bytes(&b));
            assert_eq!(header(&a,"ETag"),header(&b,"ETag"));
            assert_eq!(header(&a,contract::HEADER_MADE_BY),Some(y.as_str()));
            assert_ne!(bytes(&a),if gz{map.gzip.clone()}else{map.document.as_bytes().to_vec()});
            let tag=header(&a,"ETag").unwrap().to_owned();
            let cached=crate::dispatch(app.clone(),None,with(&url,&[("if-none-match",&tag)])).await;
            assert_eq!(cached.status,304);
        }
        // New moderation on the same cached artifact must change the reader form.
        let before=crate::dispatch(app.clone(),None,with(&url,&[])).await;
        std::thread::scope(|s|s.spawn(|| c.execute("UPDATE comments SET mod=1",&[]).unwrap()).join().unwrap());
        let after=crate::dispatch(app.clone(),None,with(&url,&[])).await;
        assert_ne!(bytes(&before),bytes(&after)); assert_eq!(text(&after),map.document);
        // A later owned map must win without recycling the derived artifact cache.
        let replacement=stored(document(10,"replacement")); let art=uuid(0xb001);
        std::thread::scope(|s|s.spawn(|| {
        c.execute("UPDATE stand_in_runs SET record=$1::text::jsonb WHERE job_id=$2::text::uuid",&[
            &json!({"families":[{"family":contract::FAMILY,"artifact_id":art,"job_id":x,"row_count":3,"scope":"delphi:all_comments"}]}).to_string(),&x]).unwrap();
        wire_at(&mut c,"test",&art,&map_family(ZID,&replacement),&x);
        }).join().unwrap());
        let out=crate::dispatch(app.clone(),None,with(&url,&[])).await;
        assert_eq!(text(&out),replacement.document); assert_eq!(header(&out,contract::HEADER_MADE_BY),None);
    });
}

#[test]
fn review_named_derived_id_reports_the_source() {
    let db = Db::new("review_named");
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    let x = listed_run(
        &mut c,
        "test",
        ZID,
        "all_comments/1",
        "2026-01-01T00:00:00.000000Z",
        None,
        None,
    );
    let map = stored(document(20, &x));
    let y = derived(
        &mut c,
        ZID,
        &x,
        &x,
        "COMPLETED",
        Some((&map_family(ZID, &map), 3)),
    );
    runtime().block_on(async {
        let app = Arc::new(app_on(&db));
        let out = crate::dispatch(
            app,
            None,
            with(
                &format!("/api/v3/delphi/topicMap?report_id=r1&job_id={y}"),
                &[],
            ),
        )
        .await;
        eprintln!(
            "named derived status={} job={:?} made_by={:?} selection={:?}",
            out.status,
            header(&out, contract::HEADER_JOB),
            header(&out, contract::HEADER_MADE_BY),
            header(&out, contract::HEADER_SELECTION)
        );
        assert_eq!(header(&out, contract::HEADER_JOB), Some(x.as_str()));
        assert_eq!(header(&out, contract::HEADER_MADE_BY), Some(y.as_str()));
    });
}

#[test]
fn review_unchanged_replies() {
    unchanged_replies(true);
}

/// The same replies with derived reads off: what the route answered before
/// derived maps, byte for byte.
#[test]
fn review_unchanged_replies_off() {
    unchanged_replies(false);
}

fn unchanged_replies(derived: bool) {
    NEXT.store(100, Ordering::SeqCst);
    let db = Db::new("review_bytes");
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    let map = stored(document(30, "fixed"));
    let job = served(
        &mut c,
        "test",
        ZID,
        "delphi",
        "participant_visible/1",
        Some(&map_family(ZID, &map)),
    );
    runtime().block_on(async {
        let mut app = app_on(&db);
        app.delphi_topic_map_derived = derived;
        let app = Arc::new(app);
        for suffix in [String::new(), format!("&job_id={job}"), "&list=jobs".into()] {
            for gz in [false, true] {
                let hs = if gz {
                    vec![("accept-encoding", "gzip")]
                } else {
                    vec![]
                };
                let out = crate::dispatch(
                    app.clone(),
                    None,
                    with(
                        &format!("/api/v3/delphi/topicMap?report_id=r1{suffix}"),
                        &hs,
                    ),
                )
                .await;
                eprintln!(
                    "PARITY suffix={suffix} gz={gz} status={} headers={:?} bodysha={:x}",
                    out.status,
                    out.headers,
                    Sha256::digest(bytes(&out))
                );
            }
        }
        std::thread::scope(|s| {
            s.spawn(|| {
                c.batch_execute("DELETE FROM stand_in_wires; DELETE FROM stand_in_runs")
                    .unwrap()
            })
            .join()
            .unwrap()
        });
        for suffix in [String::new(), format!("&job_id={job}"), "&list=jobs".into()] {
            let out = crate::dispatch(
                app.clone(),
                None,
                with(
                    &format!("/api/v3/delphi/topicMap?report_id=r1{suffix}"),
                    &[],
                ),
            )
            .await;
            eprintln!(
                "PARITY absent suffix={suffix} status={} headers={:?} bodysha={:x}",
                out.status,
                out.headers,
                Sha256::digest(bytes(&out))
            );
        }
    });
}

/// With derived reads off the route makes no derived lookup of any kind: the
/// job address table is gone, derived jobs exist, and every reply is the
/// one a route without derived maps gives; the same database with the
/// switch on fails at the lookup, so the lookup is what was skipped.
#[test]
fn derived_reads_off_make_no_derived_lookup() {
    let db = Db::new("derived_off");
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    let p = "participant_visible/1";
    let x = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-01-01T00:00:00.000000Z",
        None,
        None,
    );
    publish(&mut c, "test", ZID, "delphi", &x, &uuid(0xa000));
    let map = stored(document(20, "off"));
    let y = derived(
        &mut c,
        ZID,
        &x,
        &x,
        "COMPLETED",
        Some((&map_family(ZID, &map), 3)),
    );
    c.batch_execute("DROP TABLE delphi_job_aliases").unwrap();
    runtime().block_on(async {
        let mut off = app_on(&db);
        off.delphi_topic_map_derived = false;
        let off = Arc::new(off);
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        for target in [url.to_owned(), format!("{url}&job_id={x}")] {
            let out = crate::dispatch(off.clone(), None, with(&target, &[])).await;
            let body = no_map_body(&out);
            assert_eq!(body.reason, NoMapReason::NotStored, "{target}");
            assert_eq!(body.map_job_id, None);
            assert_eq!(header(&out, contract::HEADER_MADE_BY), None);
        }
        // The derived job named: as before derived maps, a job of the
        // conversation read as a run, with no maker named.
        let out = crate::dispatch(off.clone(), None, with(&format!("{url}&job_id={y}"), &[])).await;
        assert_eq!(header(&out, contract::HEADER_MADE_BY), None);
        assert_ne!(out.status, 500, "{}", text(&out));
        let list = crate::dispatch(off.clone(), None, with(&format!("{url}&list=jobs"), &[])).await;
        assert_eq!(list.status, 200, "{}", text(&list));
        assert!(!text(&list).contains("\"map\""), "{}", text(&list));
        let on = Arc::new(app_on(&db));
        let out = crate::dispatch(on.clone(), None, with(url, &[])).await;
        assert_eq!(out.status, 500, "the lookup runs when on: {}", text(&out));
    });
}

/// A login that may not read the job address table: every derived lookup is
/// no derived map (logged once per process), never a 500, and in-run maps
/// are served as before.
#[test]
fn a_login_that_cannot_read_job_addresses_finds_no_derived_map() {
    let db = Db::new("derived_permission");
    let mut c = db.connect();
    let role = format!("topic_map_reader_{}", std::process::id());
    c.batch_execute(&format!(
        "INSERT INTO reports VALUES('r1',{ZID});
         CREATE ROLE {role} LOGIN;
         GRANT SELECT ON ALL TABLES IN SCHEMA public TO {role};
         REVOKE SELECT ON delphi_job_aliases FROM {role};"
    ))
    .unwrap();
    let p = "participant_visible/1";
    let x = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2026-01-01T00:00:00.000000Z",
        None,
        None,
    );
    publish(&mut c, "test", ZID, "delphi", &x, &uuid(0xa000));
    let map = stored(document(20, "denied"));
    let y = derived(
        &mut c,
        ZID,
        &x,
        &x,
        "COMPLETED",
        Some((&map_family(ZID, &map), 3)),
    );
    let own_art = uuid(0xb000);
    let own = listed_run(
        &mut c,
        "test",
        ZID,
        p,
        "2025-01-01T00:00:00.000000Z",
        Some((3, &own_art)),
        None,
    );
    let own_map = stored(document(25, "own"));
    wire_at(&mut c, "test", &own_art, &map_family(ZID, &own_map), &own);
    let mut config = db.config.clone();
    config.user(&role);
    runtime().block_on(async {
        let mut app = app_on(&db);
        let pool =
            |limits| crate::db::Pool::new(Connector::Plain(Box::new(config.clone())), limits);
        app.delphi_topic_map_db = Some(pool(pool_limits()));
        app.delphi_topic_map_auth_db = Some(pool(auth_pool_limits()));
        let app = Arc::new(app);
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        for target in [
            url.to_owned(),
            format!("{url}&job_id={x}"),
            format!("{url}&job_id={y}"),
        ] {
            let out = crate::dispatch(app.clone(), None, with(&target, &[])).await;
            let body = no_map_body(&out);
            assert_eq!(body.reason, NoMapReason::NotStored, "{target}");
            assert_eq!(body.job_id.as_deref(), Some(x.as_str()));
            assert_eq!(body.map_job_id, None);
        }
        let out =
            crate::dispatch(app.clone(), None, with(&format!("{url}&job_id={own}"), &[])).await;
        assert_eq!(out.status, 200);
        assert_eq!(text(&out), own_map.document);
        let list = crate::dispatch(app.clone(), None, with(&format!("{url}&list=jobs"), &[])).await;
        assert_eq!(list.status, 200, "{}", text(&list));
        assert!(!text(&list).contains("\"map\""), "{}", text(&list));
    });
    drop(c);
    drop(db);
    let admin: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
        .unwrap()
        .parse()
        .unwrap();
    admin
        .connect(NoTls)
        .unwrap()
        .batch_execute(&format!("DROP ROLE {role}"))
        .unwrap();
}

/// A request naming the derived job itself, in each of its states: the run
/// is its source, the maker the derived job, as a read of the source.
#[test]
fn a_named_derived_job_answers_as_its_source() {
    let db = Db::new("derived_named");
    let mut c = db.connect();
    c.batch_execute(&format!("INSERT INTO reports VALUES('r1',{ZID});"))
        .unwrap();
    let p = "participant_visible/1";
    let run = |c: &mut postgres::Client, at: &str| listed_run(c, "test", ZID, p, at, None, None);
    let (xm, xp, xn, xf) = (
        run(&mut c, "2026-01-04T00:00:00.000000Z"),
        run(&mut c, "2026-01-03T00:00:00.000000Z"),
        run(&mut c, "2026-01-02T00:00:00.000000Z"),
        run(&mut c, "2026-01-01T00:00:00.000000Z"),
    );
    let map = stored(document(20, "named"));
    let no_map = no_map_family(ZID, "too_few_comments");
    let ym = derived(
        &mut c,
        ZID,
        &xm,
        &xm,
        "COMPLETED",
        Some((&map_family(ZID, &map), 3)),
    );
    let yp = derived(&mut c, ZID, &xp, &xp, "RUNNING", None);
    let yn = derived(&mut c, ZID, &xn, &xn, "COMPLETED", Some((&no_map, 1)));
    let yf = derived(&mut c, ZID, &xf, &xf, "FAILED", None);
    // A derived job of this conversation whose source is another's run.
    let foreign = listed_run(
        &mut c,
        "test",
        ZID + 1,
        p,
        "2026-01-05T00:00:00.000000Z",
        None,
        None,
    );
    let yx = derived(&mut c, ZID, &foreign, &foreign, "COMPLETED", None);
    // A derived job whose source's address names another job.
    let xo = run(&mut c, "2025-12-01T00:00:00.000000Z");
    let yo = derived(
        &mut c,
        ZID,
        &xo,
        &xo,
        "COMPLETED",
        Some((&map_family(ZID, &map), 3)),
    );
    c.execute(
        "UPDATE delphi_job_aliases SET job_id=$1::text::uuid WHERE job_id=$2::text::uuid",
        &[&ym, &yo],
    )
    .unwrap();
    runtime().block_on(async {
        let app = Arc::new(app_on(&db));
        let url = "/api/v3/delphi/topicMap?report_id=r1";
        let get = |job: &str| {
            let app = app.clone();
            let target = format!("{url}&job_id={job}");
            async move { crate::dispatch(app, None, with(&target, &[])).await }
        };
        let (by_y, by_x) = (get(&ym).await, get(&xm).await);
        assert_eq!(by_y.status, 200, "{}", text(&by_y));
        assert_eq!(bytes(&by_y), bytes(&by_x));
        assert_eq!(by_y.headers, by_x.headers);
        assert_eq!(header(&by_y, contract::HEADER_JOB), Some(xm.as_str()));
        assert_eq!(header(&by_y, contract::HEADER_MADE_BY), Some(ym.as_str()));
        assert_eq!(header(&by_y, contract::HEADER_SELECTION), Some(p));
        for (y, x, reason) in [
            (&yp, &xp, NoMapReason::MapPending),
            (&yn, &xn, NoMapReason::TooFewComments),
            (&yf, &xf, NoMapReason::MapFailed),
        ] {
            let (by_y, by_x) = (get(y).await, get(x).await);
            assert_eq!(bytes(&by_y), bytes(&by_x), "{reason:?}");
            let body = no_map_body(&by_y);
            assert_eq!(body.reason, reason);
            assert_eq!(body.job_id.as_deref(), Some(x.as_str()));
            assert_eq!(body.map_job_id.as_deref(), Some(y.as_str()));
        }
        assert_eq!(
            get(&yx).await.status,
            404,
            "a source of another conversation"
        );
        let out = get(&yo).await;
        assert_eq!(
            out.status,
            500,
            "an address naming another job: {}",
            text(&out)
        );
    });
}
