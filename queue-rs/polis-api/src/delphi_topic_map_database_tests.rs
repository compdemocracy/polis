//! The whole request against PostgreSQL. The result store's objects the route
//! reads are stand-ins with their signatures and the shapes of their answers
//! (`reports`, `delphi_result_publications`, `pd_run_record`,
//! `pd_result_artifact_wire`), so every statement the route sends is parsed,
//! typed and answered by a real server; the functions' own walks of the
//! publication history are the migrations' and are not exercised here.
use super::*;
use polis_queue_adapter::jobs::transport::Connector;
use postgres::NoTls;

struct Db {
    admin: postgres::Client,
    name: String,
    config: postgres::Config,
}

impl Db {
    fn new(label: &str) -> Self {
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
        db.connect()
            .batch_execute(
                "CREATE TABLE reports(report_id text, zid integer);
                 CREATE TABLE delphi_result_publications(env text, zid integer, scope_key text,
                   generation bigint, artifact_id uuid, job_id text);
                 CREATE TABLE stand_in_runs(env text, job_id uuid, record jsonb);
                 CREATE TABLE stand_in_wires(env text, artifact_id uuid, family text, batch_id uuid, wire text);
                 CREATE FUNCTION pd_run_record(p_env text, p_job uuid) RETURNS jsonb
                   LANGUAGE sql STABLE AS
                   $$ SELECT record FROM stand_in_runs WHERE env=p_env AND job_id=p_job $$;
                 CREATE FUNCTION pd_result_artifact_wire(p_env text, p_artifact uuid, p_family text)
                   RETURNS jsonb LANGUAGE sql STABLE AS
                   $$ SELECT jsonb_build_object('wire',wire,'sha256',encode(sha256(convert_to(wire,'UTF8')),'hex'),
                        'batch_sha256',NULL,'batch_id',batch_id)
                      FROM stand_in_wires WHERE env=p_env AND artifact_id=p_artifact AND family=p_family $$;",
            )
            .unwrap();
        db
    }
    fn connect(&self) -> postgres::Client {
        self.config.connect(NoTls).unwrap()
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

/// A family of a stored run: its name, its codec file (none: listed in the
/// record only) and the row count the record states.
type Stored<'a> = (&'a str, Option<&'a (String, u64)>, u64);

/// One stored run: its record and, for each family given, its codec file.
fn store(c: &mut postgres::Client, job: &str, zid: i32, state: &str, families: &[Stored]) {
    let mut listed = Vec::new();
    for (n, (family, wire, rows)) in families.iter().enumerate() {
        let artifact = format!("00000000-0000-4000-8000-{:012}", 100 + n);
        let batch = format!("00000000-0000-4000-9000-{:012}", 100 + n);
        listed.push(serde_json::json!({"family":family,"artifact_id":artifact,
            "batch_id":batch,"row_count":rows,"job_id":job,"served":true}));
        if let Some((text, _)) = wire {
            c.execute(
                "INSERT INTO stand_in_wires VALUES('test',$1::text::uuid,$2,$3::text::uuid,$4)",
                &[&artifact, family, &batch, text],
            )
            .unwrap();
        }
    }
    let record = serde_json::json!({"job_id":job,"zid":zid,"status":state,"state":state,
        // The fixture run's own time, so the document is the generator's.
        "created_at":"2026-11-11T02:48:21.639910","completed_at":null,"families":listed});
    c.execute(
        "INSERT INTO stand_in_runs VALUES('test',$1::text::uuid,$2::text::jsonb)",
        &[&job, &record.to_string()],
    )
    .unwrap();
}

fn request(target: &str, etag: Option<&str>) -> Request {
    let mut headers = vec![("host", "localhost"), ("x-forwarded-proto", "https")];
    if let Some(etag) = etag {
        headers.push(("if-none-match", etag));
    }
    Request {
        method: "GET".into(),
        target: target.into(),
        headers: crate::http::Headers::from_raw(headers),
        body: vec![],
    }
}

fn body(out: &Outgoing) -> String {
    match &out.body {
        crate::http::Body::Fixed(bytes) => String::from_utf8(bytes.clone()).unwrap(),
        crate::http::Body::Empty => String::new(),
        crate::http::Body::Chunked(chunks) => String::from_utf8(chunks.concat()).unwrap(),
    }
}

fn header<'a>(out: &'a Outgoing, name: &str) -> Option<&'a str> {
    out.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[test]
fn a_report_answers_its_served_runs_map_and_each_refusal() {
    let db = Db::new("route");
    let (stored, job, expected) = super::fixture("biodiversity");
    let running = "00000000-0000-4000-8000-00000000000b";
    let large = "00000000-0000-4000-8000-00000000000c";
    let unnamed = "00000000-0000-4000-8000-00000000000d";
    {
        let mut c = db.connect();
        c.batch_execute(&format!(
            "INSERT INTO reports VALUES('r1',{ZID}),('r2',77),('r0',0),('rnull',NULL);
             INSERT INTO delphi_result_publications VALUES('test',{ZID},'delphi',1,NULL,'{job}');
             INSERT INTO delphi_result_publications VALUES('test',{ZID},'other',1,NULL,'{running}');"
        ))
        .unwrap();
        store(
            &mut c,
            &job,
            ZID,
            "succeeded",
            &[
                (UMAP, Some(&stored.umap), stored.umap.1),
                (ASSIGNMENTS, Some(&stored.assignments), stored.assignments.1),
                (TOPICS, Some(&stored.topics), stored.topics.1),
            ],
        );
        store(&mut c, running, 77, "running", &[]);
        store(
            &mut c,
            large,
            ZID,
            "succeeded",
            &[
                (UMAP, None, MAX_UMAP_ROWS + 1),
                (ASSIGNMENTS, None, 10),
                (TOPICS, None, 10),
            ],
        );
        store(
            &mut c,
            unnamed,
            ZID,
            "succeeded",
            &[
                (UMAP, Some(&stored.umap), stored.umap.1),
                (ASSIGNMENTS, Some(&stored.assignments), stored.assignments.1),
            ],
        );
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut app = super::app();
        app.delphi_topic_map_db = Some(crate::db::Pool::new(
            Connector::Plain(Box::new(db.config.clone())),
            pool_limits(),
        ));
        app.delphi_topic_map_env = "test".into();
        app.delphi_topic_map_scope = Some("delphi".into());
        let app = Arc::new(app);
        let get = |target: String, etag: Option<String>| {
            let app = app.clone();
            async move { crate::dispatch(app, None, request(&target, etag.as_deref())).await }
        };
        let path = PATH;
        // The served run's map: the generator's document, to the byte.
        let first = get(format!("{path}?report_id=r1"), None).await;
        assert_eq!(first.status, 200, "{}", body(&first));
        assert_eq!(body(&first), expected);
        assert_eq!(header(&first, "content-type"), Some("application/json; charset=utf-8"));
        let etag = header(&first, "etag").unwrap().to_owned();
        let again = get(format!("{path}?report_id=r1"), Some(etag.clone())).await;
        assert_eq!(again.status, 304);
        let named = get(format!("{path}?report_id=r1&job_id={job}"), None).await;
        assert_eq!((named.status, body(&named)), (200, expected.clone()));
        assert_eq!(header(&named, "etag"), Some(etag.as_str()));
        let refusal = |status: u16, text: &str| (status, text.to_owned());
        let cases = [
            (format!("{path}?report_id=nobody"), refusal(404, r#"{"status":"error","message":"Could not find conversation for report_id","report_id":"nobody"}"#)),
            (format!("{path}?report_id=r0"), refusal(404, r#"{"status":"error","message":"Could not find conversation for report_id","report_id":"r0"}"#)),
            (format!("{path}?report_id=rnull"), refusal(404, r#"{"status":"error","message":"Could not find conversation for report_id","report_id":"rnull"}"#)),
            (format!("{path}?report_id="), refusal(400, r#"{"status":"error","message":"report_id is required"}"#)),
            // Another conversation's run, known to the cache and not.
            (format!("{path}?report_id=r2&job_id={job}"), refusal(404, r#"{"status":"error","message":"Job not found"}"#)),
            (format!("{path}?report_id=r1&job_id={running}"), refusal(404, r#"{"status":"error","message":"Job not found"}"#)),
            (format!("{path}?report_id=r1&job_id=00000000-0000-4000-8000-0000000000ff"), refusal(404, r#"{"status":"error","message":"Job not found"}"#)),
            (format!("{path}?report_id=r1&job_id=NOT-A-JOB"), refusal(404, r#"{"status":"error","message":"Job not found"}"#)),
            (format!("{path}?report_id=r1&job_id={large}"), refusal(422, r#"{"status":"error","message":"polis_err_topic_map_too_large"}"#)),
            (format!("{path}?report_id=r2"), refusal(200, r#"{"status":"success","message":"No Delphi run found for this report","report_id":"r2","job_id":null,"reason":"no_run"}"#)),
            (format!("{path}?report_id=r2&job_id={running}"), refusal(200, &format!(r#"{{"status":"success","message":"The Delphi run has not finished","report_id":"r2","job_id":"{running}","reason":"run_not_ready"}}"#))),
            (format!("{path}?report_id=r1&job_id={unnamed}"), refusal(200, &format!(r#"{{"status":"success","message":"The Delphi run stored no topics","report_id":"r1","job_id":"{unnamed}","reason":"no_topics"}}"#))),
        ];
        for (target, (status, text)) in cases {
            let out = get(target.clone(), None).await;
            assert_eq!((out.status, body(&out)), (status, text), "{target}");
        }
        // The run's map is kept: with its record gone, the served run still
        // answers, from memory.
        let config = db.config.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = config.connect(NoTls).unwrap();
            c.batch_execute("DELETE FROM stand_in_runs").unwrap();
        })
        .await
        .unwrap();
        let kept = get(format!("{path}?report_id=r1"), None).await;
        assert_eq!((kept.status, body(&kept)), (200, expected.clone()));
        assert_eq!(app.delphi_topic_map.computed(), 1);
        // Without a configured scope, two scopes serving different runs are
        // not this route's to choose between: Node answers.
        let mut unscoped = super::app();
        unscoped.delphi_topic_map_db = Some(crate::db::Pool::new(
            Connector::Plain(Box::new(db.config.clone())),
            pool_limits(),
        ));
        unscoped.delphi_topic_map_env = "test".into();
        let out = crate::dispatch(Arc::new(unscoped), None, request(&format!("{path}?report_id=r1"), None)).await;
        assert_eq!(out.status, 502);
    });
}
