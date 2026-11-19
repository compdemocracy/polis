//! Optional sealed graphs. Only explicitly listed conversations enter this path.
//! No connection is held while Python hashes the offline model or runs a node.
use super::{
    config::{ConfigError, Share, benchmark_codes, valid_env},
    db::{Db, Live},
    plan,
    scheduler::{Scheduler, log},
    storage,
};
use crate::job_graph_contract::{Image, Model};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_SPEC_BYTES: usize = 1_048_576;
/// How long a graph may wait with none of its nodes ever claimed. A graph
/// executor that runs claims the first node within one of its polls; one
/// that is absent, unstartable or refused at deploy never does. Past this
/// the graph's nodes are cancelled and the graph is let go, so a missing
/// executor costs the full-pipeline shadow minutes per listed conversation,
/// not the whole job deadline.
pub const UNCLAIMED_DEADLINE: Duration = Duration::from_secs(600);
/// Publication attempts per graph, one per poll, the count carried in the
/// flight (`Flight::publish_attempts`).
pub const PUBLISH_ATTEMPTS: u32 = 3;
/// How many given-up publications the state file keeps (the newest). Only
/// an env's newest graph can be recovered, so a short list is enough.
const UNPUBLISHED_KEPT: usize = 64;
// Count and snapshot deliberately include invalid/blank texts: these refuse the
// conversation instead of silently changing its scientific input.
const INCLUDED: &str = "NOT EXISTS (SELECT 1 FROM report_comment_selections r WHERE r.zid=c.zid AND r.tid=c.tid AND r.selection=-1)";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    #[serde(default)]
    pub rule: String,
    pub comments: i64,
    pub last_modified: i64,
}
impl Observation {
    fn new(c: &Live, build: &str) -> Self {
        Self {
            rule: format!("graph-admission/2:{build}"),
            comments: c.comments,
            last_modified: c.last_modified,
        }
    }
}
#[derive(Debug)]
struct Refusal(&'static str);
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Refusal {}
fn bound(ok: bool, reason: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Refusal(reason).into())
    }
}

/// Only counts and modification times leave the primary on an ordinary poll.
/// Report exclusions are scoped by both conversation and comment, as in snapshot.
pub fn listed(db: &Db<'_>, codes: &[String]) -> Result<Vec<Live>> {
    db.read(|tx| {
        let sql = format!("WITH wanted AS (SELECT code,ord FROM unnest($1::text[]) WITH ORDINALITY w(code,ord)), listed AS (SELECT min(w.ord) ord,z.zid FROM wanted w JOIN zinvites z ON z.zinvite=w.code GROUP BY z.zid) SELECT l.zid, count(c.tid) FILTER (WHERE {INCLUDED})::bigint, greatest(max(c.modified), (SELECT max(r.modified) FROM report_comment_selections r WHERE r.zid=l.zid))::bigint FROM listed l LEFT JOIN comments c ON c.zid=l.zid GROUP BY l.ord,l.zid ORDER BY l.ord");
        tx.query(&sql, &[&codes])?.iter().map(|r| Ok(Live { zid:r.try_get(0)?, comments:r.try_get(1)?, last_modified:r.try_get::<_,Option<i64>>(2)?.unwrap_or(0) })).collect()
    })
}

pub fn default_model() -> Result<&'static str> {
    Ok(&Model::Granite
        .definition()
        .map_err(anyhow::Error::msg)?
        .model)
}
pub fn scope(zid: i32) -> String {
    format!("shadow-graph:{zid}")
}

pub const STAGES: [&str; 4] = [
    "graph_embed",
    "graph_cluster",
    "graph_topics",
    "graph_narrative",
];
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub codes: Vec<String>,
    pub env: String,
    pub app: PathBuf,
    pub python: String,
    pub embedding_model: String,
}
impl Config {
    pub fn load(
        get: &impl Fn(&str) -> Option<String>,
        writer_env: &str,
    ) -> Result<Option<Self>, ConfigError> {
        let codes = benchmark_codes(&get("DELPHI_SHADOW_GRAPH_CONVERSATIONS").unwrap_or_default())
            .map_err(|e| {
                ConfigError(e.0.replace(
                    "DELPHI_SHADOW_BENCHMARK",
                    "DELPHI_SHADOW_GRAPH_CONVERSATIONS",
                ))
            })?;
        if codes.is_empty() {
            return Ok(None);
        }
        let env = get("DELPHI_SHADOW_GRAPH_ENV")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "shadow-graph-1".into());
        if !valid_env(&env) || env == writer_env {
            return Err(ConfigError(
                "DELPHI_SHADOW_GRAPH_ENV must be a distinct shadow env".into(),
            ));
        }
        let names: BTreeMap<String, String> = serde_json::from_str(
            &get("DELPHI_EMBED_MODEL_BY_ENV")
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "{}".into()),
        )
        .map_err(|_| {
            ConfigError("DELPHI_EMBED_MODEL_BY_ENV must map environments to model names".into())
        })?;
        let embedding_model = names.get(&env).cloned().unwrap_or(
            default_model()
                .map_err(|_| ConfigError("embedding registry invalid".into()))?
                .into(),
        );
        let definition = Model::named(&embedding_model)
            .and_then(|m| m.definition())
            .map_err(ConfigError)?;
        if definition.step != crate::job_graph_contract::Step::Embeddings {
            return Err(ConfigError(
                "selected model does not produce embeddings".into(),
            ));
        }
        Ok(Some(Self {
            embedding_model,
            codes,
            env,
            app: get("DELPHI_APP_PATH")
                .unwrap_or_else(|| "/app".into())
                .into(),
            python: get("POLIS_JOBS_PYTHON").unwrap_or_else(|| "python3".into()),
        }))
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub job_id: String,
    pub run_id: String,
    pub stage: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Flight {
    pub env: String,
    pub graph_id: String,
    pub zid: i32,
    pub digest: String,
    pub comments: i64,
    pub admitted_at_ms: i64,
    pub generation: i64,
    pub nodes: Vec<Node>,
    /// Publication attempts already made, one per poll (absent when none).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub publish_attempts: u32,
}
fn is_zero(n: &u32) -> bool {
    *n == 0
}
#[derive(Debug)]
pub struct Snapshot {
    pub ids: Vec<i64>,
    pub texts: Vec<String>,
    pub digest: String,
}

pub fn snapshot(db: &Db<'_>, zid: i32) -> Result<Snapshot> {
    db.read(|tx| {
        // include_moderation=false retains every moderation/active status,
        // exactly as run_pipeline._read_inputs does; report exclusions apply.
        let sql = format!("SELECT c.tid::bigint,c.txt FROM comments c WHERE c.zid=$1 AND {INCLUDED} ORDER BY c.tid LIMIT 2001");
        let rows = tx.query(&sql, &[&zid])?;
        bound((5..=2000).contains(&rows.len()), "graph_comment_bound")?;
        let mut ids=Vec::new(); let mut texts=Vec::new();
        for r in rows { ids.push(r.try_get::<_,i64>(0)?); texts.push(r.try_get::<_,Option<String>>(1)?.unwrap_or_default()); }
        bound(texts.iter().all(|s| !s.trim().is_empty() && s.chars().count()<=4096), "graph_text_bound")?;
        let digest=crate::jobs::sha256_hex(serde_json::to_string(&json!({"ids":ids,"texts":texts}))?.as_bytes());
        Ok(Snapshot { ids, texts, digest })
    })
}

/// The helper reads local files only. A cleared environment carries no database
/// or provider credential. Its stderr is not a scheduler log.
// File metadata only, never file contents. Image files are immutable in the
// deployed container. For local mounts, inode/size/mtime/ctime changes invalidate
// the cache; the child independently verifies the declared byte digest before use.
fn provenance_identity(cfg: &Config) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    fn visit(p: &Path, out: &mut Vec<String>) -> Result<()> {
        let m = std::fs::metadata(p)?;
        out.push(format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            p.display(),
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec()
        ));
        if m.is_dir() {
            let mut paths = std::fs::read_dir(p)?
                .map(|e| e.map(|e| e.path()))
                .collect::<std::io::Result<Vec<_>>>()?;
            paths.sort();
            for path in paths {
                if path.file_name().is_some_and(|n| n != "__pycache__") {
                    visit(&path, out)?;
                }
            }
        }
        Ok(())
    }
    let mut rows = Vec::new();
    for path in [
        cfg.app.join("scripts"),
        cfg.app.join("umap_narrative"),
        cfg.app.join("polismath/embedding_model.py"),
        cfg.app.join("polismath/job-models.json"),
    ] {
        if path.exists() {
            visit(&path, &mut rows)?;
        }
    }
    for key in ["DELPHI_EMBED_MODEL_PATH", "DELPHI_EMBED_MODEL_LOCK"] {
        if let Some(path) = std::env::var_os(key) {
            visit(Path::new(&path), &mut rows)?;
        }
    }
    Ok(crate::jobs::sha256_hex(rows.join("\n").as_bytes()))
}

/// Drain at most 4097 stdout bytes concurrently, discard stderr, kill and reap
/// on timeout or excessive output. Never wait for an unbounded output buffer.
fn bounded_output(mut c: Command, deadline: Duration) -> Result<Vec<u8>> {
    c.stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    let mut child = c.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("graph_provenance_pipe"))?;
    let (send, recv) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(4097).read_to_end(&mut bytes).map(|_| bytes);
        let _ = send.send(result);
    });
    let start = Instant::now();
    let mut output = None;
    loop {
        if let Ok(result) = recv.try_recv() {
            output = Some(result);
        }
        let oversized = matches!(&output,Some(Ok(bytes)) if bytes.len()>4096);
        if oversized || start.elapsed() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!(if oversized {
                "graph_provenance_output_bound"
            } else {
                "graph_provenance_timeout"
            });
        }
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "graph_provenance_failed");
            if let Some(bytes) = output {
                return Ok(bytes?);
            }
            let left = deadline.saturating_sub(start.elapsed());
            return Ok(recv
                .recv_timeout(left)
                .map_err(|_| anyhow::anyhow!("graph_provenance_timeout"))??);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn provenance(cfg: &Config) -> Result<Value> {
    let mut c = Command::new(&cfg.python);
    c.env_clear()
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("DELPHI_RESULT_ENV", &cfg.env)
        .arg(cfg.app.join("scripts/graph_provenance.py"));
    for key in [
        "PATH",
        "HOME",
        "PYTHONPATH",
        "DELPHI_EMBED_MODEL_PATH",
        "DELPHI_EMBED_MODEL_LOCK",
        "DELPHI_EMBED_MODEL_BY_ENV",
    ] {
        if let Some(value) = std::env::var_os(key) {
            c.env(key, value);
        }
    }
    let bytes = bounded_output(c, Duration::from_secs(120))?;
    ensure!(bytes.len() <= 4096, "graph_provenance_output_bound");
    let v: Value = serde_json::from_slice(&bytes)?;
    ensure!(v["model"] == cfg.embedding_model, "graph_model_mismatch");
    Ok(v)
}
pub fn spec(s: &Snapshot, sha: &str, provenance: &Value) -> Result<Value> {
    let mut nodes = Vec::new();
    for (i, stage) in STAGES.iter().enumerate() {
        let model = [
            Model::named(provenance["model"].as_str().unwrap_or(default_model()?))
                .map_err(anyhow::Error::msg)?,
            Model::UmapEvoc,
            Model::TfidfKeywords,
            Model::KeywordLabels,
        ][i];
        let inputs = if i == 0 {
            json!([])
        } else {
            json!([{"node":STAGES[i-1],"role":(["","embeddings","clusters","topics"][i])}])
        };
        nodes.push(crate::job_graph_contract::node(stage, model, json!({"snapshot":{"data":{"texts":s.texts},"sha256":sha},
              "code":provenance["code"],"runtime":provenance["runtime"],"seed":42,
              "mode":"full","memory_bytes":4294967296_u64,"work_units":s.ids.len(),
              "config":{"comment_ids":s.ids,"adapter_sha256":provenance["adapter_sha256"],"model_sha256":provenance["model_sha256"],
                        "shadow":{"comments":s.ids.len(),"graph_snapshot_sha256":s.digest}}}), inputs, 3).map_err(anyhow::Error::msg)?);
    }
    let v = json!({"schema":"polis-job-graph/1","nodes":nodes});
    bound(
        serde_json::to_vec(&v)?.len() <= MAX_SPEC_BYTES,
        "graph_spec_bound",
    )?;
    Ok(v)
}

impl Scheduler<'_> {
    /// Recover the latest unpublished or live graph before another admission.
    /// Only ids, digests and counts leave SQL; no snapshot text is returned.
    pub(super) fn recover_graph(&mut self) -> Result<()> {
        if let Some(cfg) = self.cfg.graph.as_ref()
            && !self.state.graph_recovery_envs.contains(&cfg.env)
        {
            self.state.graph_recovery_envs.push(cfg.env.clone());
            // Persist the recovery domain before any admission can commit.
            self.state.save(&self.cfg.state_path)?;
        }
        if let Some(f) = &self.state.graph_flight
            && !self.state.graph_recovery_envs.contains(&f.env)
        {
            self.state.graph_recovery_envs.push(f.env.clone());
        }
        if self.state.graph_flight.is_some() {
            return Ok(());
        }
        // Deferred graphs are polled on their own; graphs whose publication
        // was given up are not taken up again.
        let deferred: Vec<String> = self
            .state
            .graph_deferred
            .iter()
            .map(|f| f.graph_id.clone())
            .chain(self.state.graph_unpublished.iter().cloned())
            .collect();
        let unpublished = self.state.graph_unpublished.clone();
        for env in self.state.graph_recovery_envs.clone() {
            let recovered=self.db.read(|tx| {
            // A snapshot whose publication was given up is not remembered as seen.
            let rows=tx.query("SELECT DISTINCT ON (zid) zid, coalesce(request #>> '{nodes,0,declared,config,shadow,graph_snapshot_sha256}',request #>> '{nodes,0,declared,config,shadow,comment_set_sha256}') FROM delphi_graphs WHERE env=$1 AND scope_key='shadow-graph:'||zid::text AND NOT (graph_id::text=ANY($2::text[])) ORDER BY zid,created_at DESC", &[&env,&unpublished])?;
            let mut seen=BTreeMap::new();
            for r in rows { if let Some(digest)=r.try_get::<_,Option<String>>(1)? { seen.insert(r.try_get::<_,i32>(0)?,digest); } }
            let row=tx.query_opt("SELECT g.graph_id::text,g.zid, (extract(epoch FROM g.created_at)*1000)::bigint, coalesce(g.request #>> '{nodes,0,declared,config,shadow,graph_snapshot_sha256}',request #>> '{nodes,0,declared,config,shadow,comment_set_sha256}'), (g.request #>> '{nodes,0,declared,config,shadow,comments}')::bigint, (g.request #>> '{nodes,0,declared,config,shadow,expected_generation}')::bigint FROM delphi_graphs g WHERE g.env=$1 AND NOT (g.graph_id::text=ANY($2::text[])) AND g.scope_key='shadow-graph:'||g.zid::text AND (g.request #>> '{nodes,0,declared,config,shadow,comments}') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM delphi_graphs newer WHERE newer.env=g.env AND newer.scope_key='shadow-graph:'||newer.zid::text AND newer.created_at>g.created_at) AND (EXISTS (SELECT 1 FROM delphi_job_guards d WHERE d.env=g.env AND d.root_job_id=g.root_job_id) OR (NOT EXISTS (SELECT 1 FROM delphi_graph_nodes n JOIN polis_queue_jobs q USING(env,job_id) WHERE n.env=g.env AND n.graph_id=g.graph_id AND q.state<>'succeeded') AND NOT EXISTS (SELECT 1 FROM delphi_graph_served s JOIN delphi_artifacts a USING(env,artifact_id) JOIN delphi_graph_nodes n USING(env,job_id) WHERE s.env=g.env AND n.graph_id=g.graph_id))) ORDER BY g.created_at,g.graph_id LIMIT 1", &[&env,&deferred])?;
            let Some(r)=row else { return Ok((seen,None)); };
            let graph_id:String=r.try_get(0)?;
            let mut nodes=Vec::new();
            for n in tx.query("SELECT n.job_id::text,n.run_id::text,q.stage FROM delphi_graph_nodes n JOIN polis_queue_jobs q USING(env,job_id) WHERE n.env=$1 AND n.graph_id=$2::text::uuid ORDER BY n.node_key", &[&env,&graph_id])? {
                nodes.push(Node {job_id:n.try_get(0)?,run_id:n.try_get(1)?,stage:n.try_get(2)?});
            }
            ensure!(nodes.len()==4 && STAGES.iter().all(|s|nodes.iter().filter(|n|n.stage==*s).count()==1),"graph_recovery_shape");
            Ok((seen,Some(Flight {env:env.clone(),graph_id,zid:r.try_get(1)?,admitted_at_ms:r.try_get(2)?,digest:r.try_get(3)?,comments:r.try_get(4)?,generation:r.try_get::<_,Option<i64>>(5)?.unwrap_or(-1),nodes,publish_attempts:0})))
        })?;
            self.state.graph_seen.extend(recovered.0);
            self.state.graph_flight = recovered.1;
            if self.state.graph_flight.is_some() {
                break;
            }
        }
        Ok(())
    }

    /// Called only when configured, after pacing and before any admission.
    /// The existing featured roster is neither read nor changed here.
    pub(super) fn admit_graph(&mut self, now: i64) -> Result<bool> {
        let Some(cfg) = self.cfg.graph.as_ref() else {
            return Ok(false);
        };
        if !self.state.graph_deferred.is_empty() {
            // Said once while the same graphs hold it (they are polled in
            // rotation, so the line names them sorted), never every poll.
            let mut held: Vec<&str> = self
                .state
                .graph_deferred
                .iter()
                .map(|f| f.graph_id.as_str())
                .collect();
            held.sort_unstable();
            let key = held.join(",");
            if self.graph_held.as_deref() != Some(key.as_str()) {
                log(
                    "graph_admission_held",
                    json!({"reason":"graph_deferred","deferred":held.len(),"graph_ids":held}),
                );
                self.graph_held = Some(key);
            }
            return Ok(false);
        }
        self.graph_held = None;
        let cfg = cfg.clone();
        let listed = listed(&self.db, &cfg.codes)?;
        let counts = (cfg.codes.len(), listed.len());
        if self.graph_list_counts != Some(counts) {
            log("graph_roster", json!({"listed":counts.0,"found":counts.1}));
            self.graph_list_counts = Some(counts);
        }
        for candidate in listed {
            let observed = Observation::new(&candidate, &self.cfg.code_version);
            if self.state.graph_observed.get(&candidate.zid) == Some(&observed) {
                continue;
            }
            if !(self.cfg.min_comments.max(5)..=2000).contains(&candidate.comments) {
                self.refuse_graph(&candidate, "graph_comment_bound");
                continue;
            }
            // Check capacity before fetching any comment text.
            if plan::storage_room(
                self.cfg,
                &self.state.storage,
                candidate.comments * 4,
                Share::Shared,
            )
            .is_some()
            {
                return Ok(false);
            }
            match self.admit_graph_candidate(&cfg, &candidate, now) {
                Ok(true) => {
                    self.state.graph_observed.insert(candidate.zid, observed);
                    return Ok(true);
                }
                Ok(false) => {
                    if self.state.graph_observed.get(&candidate.zid) == Some(&observed) {
                        continue;
                    }
                    return Ok(false);
                }
                Err(e) => {
                    if let Some(refusal) = e.downcast_ref::<Refusal>() {
                        self.refuse_graph(&candidate, refusal.0);
                    } else {
                        return Err(e);
                    }
                }
            }
        }
        Ok(false)
    }

    fn refuse_graph(&mut self, candidate: &Live, reason: &str) {
        log(
            "graph_refused",
            json!({"reason":reason,"comments":candidate.comments}),
        );
        self.state.graph_observed.insert(
            candidate.zid,
            Observation::new(candidate, &self.cfg.code_version),
        );
    }

    fn admit_graph_candidate(&mut self, cfg: &Config, candidate: &Live, now: i64) -> Result<bool> {
        let s = snapshot(&self.db, candidate.zid)?;
        if self.state.graph_seen.get(&candidate.zid) == Some(&s.digest) {
            self.state.graph_observed.insert(
                candidate.zid,
                Observation::new(candidate, &self.cfg.code_version),
            );
            return Ok(false);
        }
        // Four jobs plus all three inline copies per node. Charge the
        // conservative request bound before admission, not after it grows.
        let comments = s.ids.len() as i64;
        if plan::storage_room(self.cfg, &self.state.storage, comments * 4, Share::Shared).is_some()
        {
            return Ok(false);
        }
        let identity = provenance_identity(cfg)?;
        if self
            .graph_provenance
            .as_ref()
            .is_none_or(|(key, _)| key != &identity)
        {
            let value = provenance(cfg)?;
            ensure!(
                provenance_identity(cfg)? == identity,
                "graph_provenance_changed"
            );
            self.graph_provenance = Some((identity, value));
        }
        let p = &self
            .graph_provenance
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("graph_provenance_missing"))?
            .1;
        let mut client = self.db.connect_queue()?;
        let data = json!({"texts":s.texts}).to_string();
        let sha: String = client
            .query_one(
                "SELECT encode(sha256(convert_to(($1::text::jsonb)::text,'UTF8')),'hex')",
                &[&data],
            )?
            .try_get(0)?;
        let graph_scope = scope(candidate.zid);
        let generation: i64 = client
            .query_one(
                "SELECT coalesce((public.pd_graph_served($1,$2,$3)->>'generation')::bigint,0)",
                &[&cfg.env, &candidate.zid, &graph_scope],
            )?
            .try_get(0)?;
        let mut specification = spec(&s, &sha, p)?;
        for node in specification["nodes"]
            .as_array_mut()
            .ok_or_else(|| anyhow::anyhow!("graph_nodes_missing"))?
        {
            node["declared"]["config"]["shadow"]["expected_generation"] = json!(generation);
        }
        let specification = specification.to_string();
        let sql_bytes: i32 = client
            .query_one(
                "SELECT octet_length(($1::text::jsonb)::text)",
                &[&specification],
            )?
            .try_get(0)?;
        bound(sql_bytes as usize <= MAX_SPEC_BYTES, "graph_spec_bound")?;
        let estimate = self
            .state
            .storage
            .estimate(comments * 4)
            .saturating_add(sql_bytes as u64 * 3);
        if self.state.storage.bytes.saturating_add(estimate)
            > self.cfg.storage_limit_bytes(Share::Shared)
            || self
                .cfg
                .storage_daily_bytes
                .is_some_and(|n| self.state.storage.day_bytes.saturating_add(estimate) > n)
        {
            return Ok(false);
        }
        let key = crate::jobs::sha256_hex(format!("{}:{specification}", candidate.zid).as_bytes());
        let image: Image = serde_json::from_value(p.clone())?;
        let reply = crate::jobs::admission::admit(
            &mut client,
            &cfg.env,
            candidate.zid,
            &graph_scope,
            &key,
            serde_json::from_str(&specification)?,
            &image,
            None,
        )?;
        let graph_id = reply["graph_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("graph_admission_reply"))?
            .to_owned();
        let view: String = client
            .query_one(
                "SELECT public.pd_graph_view($1,$2::text::uuid)::text",
                &[&cfg.env, &graph_id],
            )?
            .try_get(0)?;
        let view: Value = serde_json::from_str(&view)?;
        let mut nodes = Vec::new();
        for n in view["nodes"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("graph_nodes_missing"))?
        {
            nodes.push(Node {
                job_id: n["job_id"].as_str().unwrap_or_default().into(),
                run_id: n["run_id"].as_str().unwrap_or_default().into(),
                stage: n["key"].as_str().unwrap_or_default().into(),
            });
        }
        ensure!(
            nodes.len() == 4
                && STAGES
                    .iter()
                    .all(|s| nodes.iter().filter(|n| n.stage == *s).count() == 1),
            "graph_nodes_mismatch"
        );
        log(
            "graph_admitted",
            json!({"graph_id":graph_id,"nodes":nodes,"comments":comments,"env":cfg.env}),
        );
        self.state
            .graph_seen
            .insert(candidate.zid, s.digest.clone());
        // The same snapshot's graph, taken up again after its publication
        // was given up (the admission answers with the existing graph).
        self.state.graph_unpublished.retain(|g| g != &graph_id);
        self.graph_wait_bucket = None;
        self.state.graph_flight = Some(Flight {
            env: cfg.env.clone(),
            graph_id,
            zid: candidate.zid,
            digest: s.digest,
            comments,
            admitted_at_ms: now,
            generation,
            nodes,
            publish_attempts: 0,
        });
        self.state.day_runs += 1;
        self.state.totals.admitted += 1;
        Ok(true)
    }

    pub(super) fn graph_scope_held(&self, zid: i32) -> Result<bool> {
        if self.state.graph_recovery_envs.is_empty() {
            return Ok(false);
        }
        self.db.read(|tx| Ok(tx.query_one(
            "SELECT EXISTS (SELECT 1 FROM delphi_graphs g JOIN delphi_job_guards d ON d.env=g.env AND d.root_job_id=g.root_job_id WHERE g.env=ANY($1::text[]) AND g.zid=$2 AND g.scope_key='shadow-graph:'||g.zid::text)",
            &[&self.state.graph_recovery_envs, &zid])?.try_get(0)?))
    }

    pub(super) fn poll_deferred_graph(&mut self, now: i64) -> Result<()> {
        // One per cycle; rotation keeps recovery polling bounded and fair.
        if !self.state.graph_deferred.is_empty() {
            let flight = self.state.graph_deferred[0].clone();
            self.state.graph_deferred.rotate_left(1);
            self.watch_graph(flight, now)?;
        }
        Ok(())
    }

    fn defer_graph(&mut self, flight: &Flight, now: i64) {
        if now.saturating_sub(flight.admitted_at_ms) < self.cfg.job_deadline.as_millis() as i64 {
            return;
        }
        if !self
            .state
            .graph_deferred
            .iter()
            .any(|f| f.graph_id == flight.graph_id)
        {
            self.state.graph_deferred.push(flight.clone());
            log(
                "graph_recovery_pending",
                json!({"graph_id":flight.graph_id,"reason":"wait_bound","scope_held":true}),
            );
        }
        if self
            .state
            .graph_flight
            .as_ref()
            .is_some_and(|f| f.graph_id == flight.graph_id)
        {
            self.state.graph_flight = None;
        }
    }

    /// Record a failed publication attempt in the flight it belongs to (in
    /// flight or deferred), so the count survives the poll and a restart.
    fn note_publish_attempt(&mut self, graph_id: &str, attempts: u32) {
        for flight in self
            .state
            .graph_flight
            .iter_mut()
            .chain(self.state.graph_deferred.iter_mut())
        {
            if flight.graph_id == graph_id {
                flight.publish_attempts = attempts;
            }
        }
    }

    /// The publication was given up: the snapshot is not remembered as seen,
    /// so a later build or a change reconsiders the conversation (the same
    /// snapshot's admission answers with this graph, and only its
    /// publication runs again), and recovery does not take it up again.
    fn give_up_publication(&mut self, flight: &Flight) {
        if self.state.graph_seen.get(&flight.zid) == Some(&flight.digest) {
            self.state.graph_seen.remove(&flight.zid);
        }
        if !self.state.graph_unpublished.contains(&flight.graph_id) {
            self.state.graph_unpublished.push(flight.graph_id.clone());
        }
        let excess = self
            .state
            .graph_unpublished
            .len()
            .saturating_sub(UNPUBLISHED_KEPT);
        self.state.graph_unpublished.drain(..excess);
    }

    fn log_graph_wait(
        &mut self,
        flight: &Flight,
        now: i64,
        states: &BTreeMap<String, (String, f64)>,
        scope_held: bool,
    ) -> Result<()> {
        let deadline = (self.cfg.job_deadline.as_millis() as i64).max(1);
        let overdue = (now - flight.admitted_at_ms - deadline).max(0);
        let bucket = overdue / deadline;
        if now - flight.admitted_at_ms >= deadline && self.graph_wait_bucket != Some(bucket) {
            let unconfirmed: i64 = self.db.read(|tx| Ok(tx.query_one(
                "SELECT count(*) FROM polis_queue_attempts a JOIN delphi_graph_nodes n USING(env,job_id) WHERE n.env=$1 AND n.graph_id=$2::text::uuid AND a.process_exit_confirmed_at IS NULL",
                &[&flight.env, &flight.graph_id])?.try_get(0)?))?;
            let reason = if states.values().any(|(s, _)| s == "running") {
                "nodes_active"
            } else if unconfirmed > 0 {
                "exit_unconfirmed"
            } else if states
                .values()
                .any(|(s, _)| !matches!(s.as_str(), "succeeded" | "dead" | "cancelled"))
            {
                "nodes_active"
            } else {
                "reconciliation_pending"
            };
            log(
                "graph_waiting",
                json!({"graph_id":flight.graph_id,"states":states,"scope_held":scope_held,"seconds_overdue":overdue/1000,"reason":reason,"unconfirmed_attempts":unconfirmed}),
            );
            self.graph_wait_bucket = Some(bucket);
        }
        Ok(())
    }

    pub(super) fn watch_graph(&mut self, flight: Flight, now: i64) -> Result<Duration> {
        let states=self.db.read(|tx| {
            let mut out=BTreeMap::new();
            for n in &flight.nodes {
                let r=tx.query_one("SELECT q.state, coalesce((SELECT sum(extract(epoch FROM (a.ended_at-a.started_at)))::double precision FROM polis_queue_attempts a WHERE a.env=q.env AND a.job_id=q.job_id),0)::double precision FROM polis_queue_jobs q WHERE q.env=$1 AND q.job_id=$2::text::uuid",&[&flight.env,&n.job_id])?;
                out.insert(n.job_id.clone(),(r.try_get::<_,String>(0)?,r.try_get::<_,f64>(1)?));
            }
            Ok(out)
        })?;
        let failed = states
            .values()
            .any(|(s, _)| matches!(s.as_str(), "dead" | "cancelled"));
        let overdue = now - flight.admitted_at_ms > self.cfg.job_deadline.as_millis() as i64;
        // Past the short deadline with every node still queued, one read says
        // whether any node was ever claimed (any attempt at all).
        let unclaimed = !failed
            && !overdue
            && now - flight.admitted_at_ms > UNCLAIMED_DEADLINE.as_millis() as i64
            && states.values().all(|(s, _)| s == "queued")
            && self.db.read(|tx| Ok(tx.query_one(
                "SELECT NOT EXISTS (SELECT 1 FROM polis_queue_attempts a JOIN delphi_graph_nodes n USING(env,job_id) WHERE n.env=$1 AND n.graph_id=$2::text::uuid)",
                &[&flight.env, &flight.graph_id])?.try_get::<_, bool>(0)?))?;
        if unclaimed {
            log(
                "graph_unclaimed",
                json!({"graph_id":flight.graph_id,"seconds":(now - flight.admitted_at_ms)/1000,"reason":"no_executor_claim"}),
            );
        }
        if failed || overdue || unclaimed {
            let mut client = self.db.connect_queue()?;
            for n in &flight.nodes {
                // The queue's fenced management call refuses terminal rewrites.
                // A child racing this call is fenced and drained by the daemon.
                let status: String = client
                    .query_one(
                        "SELECT public.pq_job_status($1,$2::text::uuid)::text",
                        &[&flight.env, &n.job_id],
                    )?
                    .try_get(0)?;
                let status: Value = serde_json::from_str(&status)?;
                let version = status["mgmt_version"]
                    .as_str()
                    .and_then(|s| s.parse::<i64>().ok())
                    .or_else(|| status["mgmt_version"].as_i64())
                    .ok_or_else(|| anyhow::anyhow!("graph_management_version"))?;
                client.query_one(
                    "SELECT public.pq_cancel($1,$2::text::uuid,$3)::text",
                    &[&flight.env, &n.job_id, &version],
                )?;
            }
        }
        let terminal = states
            .values()
            .all(|(s, _)| matches!(s.as_str(), "succeeded" | "dead" | "cancelled"));
        // A dead producer reconciles its dependent nodes through the daemon.
        // Keep this conversation excluded while execution remains unresolved.
        // After the deadline, deferred tracking allows other conversations.
        if !terminal {
            self.log_graph_wait(&flight, now, &states, true)?;
            self.defer_graph(&flight, now);
            return Ok(self.cfg.job_poll);
        }
        let mut client = self.db.connect_queue()?;
        client.query_one("SELECT public.pd_graph_reconcile($1)::text", &[&flight.env])?;
        let view: String = client
            .query_one(
                "SELECT public.pd_graph_view($1,$2::text::uuid)::text",
                &[&flight.env, &flight.graph_id],
            )?
            .try_get(0)?;
        let view: Value = serde_json::from_str(&view)?;
        if view["guard_held"] != false {
            self.log_graph_wait(&flight, now, &states, true)?;
            self.defer_graph(&flight, now);
            return Ok(self.cfg.job_poll);
        }
        drop(client);
        let success = states.values().all(|(s, _)| s == "succeeded");
        let mut published = false;
        if success {
            let leaf = flight
                .nodes
                .iter()
                .find(|n| n.stage == "graph_narrative")
                .ok_or_else(|| anyhow::anyhow!("graph_leaf_missing"))?;
            // One attempt per poll, on a fresh connection, and every read
            // too, including after a commit whose reply was lost. A transient
            // failure keeps the flight, the count carried in it, and is
            // retried on a later poll; no retry follows a definite refusal.
            let result = (|| -> Result<Value> {
                let mut client = self.db.connect_queue()?;
                let row = client.query_one(
                    "SELECT public.pd_graph_publish($1,$2::text::uuid,$3::text::uuid,$4)",
                    &[
                        &flight.env,
                        &flight.graph_id,
                        &leaf.job_id,
                        &flight.generation,
                    ],
                )?;
                Ok(row.try_get(0)?)
            })();
            // A publish reply alone does not establish which root is served.
            let served = (|| -> Result<Value> {
                let mut client = self.db.connect_queue()?;
                let row = client.query_one(
                    "SELECT public.pd_graph_served($1,$2,$3)",
                    &[&flight.env, &flight.zid, &scope(flight.zid)],
                )?;
                Ok(row.try_get::<_, Option<Value>>(0)?.unwrap_or(Value::Null))
            })();
            match served {
                Ok(ref value) if exact_leaf(value, &leaf.job_id, flight.generation) => {
                    published = true;
                }
                // The outcome is still unknown. Keep the flight and resolve
                // it on a later poll; never count an uncertain commit failed.
                Err(error) => return Err(error),
                _ => {}
            }
            if !published {
                let attempts = flight.publish_attempts.saturating_add(1);
                let retry = result.as_ref().err().is_some_and(publish_transient);
                if retry && attempts < PUBLISH_ATTEMPTS {
                    self.note_publish_attempt(&flight.graph_id, attempts);
                    log(
                        "graph_publish_retry",
                        json!({"graph_id":flight.graph_id,"attempt":attempts}),
                    );
                    return Ok(self.cfg.poll);
                }
                log(
                    "graph_publish_failed",
                    json!({"graph_id":flight.graph_id,"reason":"publication_not_served"}),
                );
                self.give_up_publication(&flight);
            }
        }
        let mut bytes = 0u64;
        let mut graph_bytes = 0u64;
        for n in &flight.nodes {
            let measured = self.db.read(|tx| {
                let mut m = storage::measure(tx, &flight.env, &n.job_id, flight.zid)?;
                m.graph_bytes = measure_records(tx, &flight.env, &n.job_id)?;
                Ok(m)
            });
            let m = match measured {
                Ok(m) => m,
                Err(_) => {
                    log(
                        "graph_storage_unread",
                        json!({"graph_id":flight.graph_id,"job_id":n.job_id}),
                    );
                    self.state.storage.pending.push(storage::Pending {
                        env: flight.env.clone(),
                        job_id: n.job_id.clone(),
                        zid: flight.zid,
                        comments: flight.comments,
                        set: None,
                    });
                    continue;
                }
            };
            graph_bytes += m.graph_bytes;
            bytes = bytes.saturating_add(m.total());
            let (state, seconds) = &states[&n.job_id];
            log(
                "graph_node_finished",
                json!({"graph_id":flight.graph_id,"job_id":n.job_id,"run_id":n.run_id,"stage":n.stage,"state":state,"seconds":seconds,"bytes":m.total()}),
            );
        }
        self.state.storage.add(now, flight.comments, bytes);
        if published {
            self.state.totals.succeeded += 1;
        } else {
            self.state.totals.failed += 1;
        }
        log(
            "graph_finished",
            json!({"graph_id":flight.graph_id,"published":published,"bytes":bytes,"graph_row_bytes":graph_bytes}),
        );
        let deferred = self
            .state
            .graph_deferred
            .iter()
            .any(|f| f.graph_id == flight.graph_id);
        self.state
            .graph_deferred
            .retain(|f| f.graph_id != flight.graph_id);
        if self
            .state
            .graph_flight
            .as_ref()
            .is_some_and(|f| f.graph_id == flight.graph_id)
        {
            self.state.graph_flight = None;
        }
        if deferred {
            return Ok(self.cfg.job_poll);
        }
        self.rest_until_ms = now + plan::rest_ms(self.cfg.duty_cycle, now - flight.admitted_at_ms);
        Ok(Duration::from_millis(
            (self.rest_until_ms - now).max(1000) as u64
        ))
    }
}

fn publish_transient(error: &anyhow::Error) -> bool {
    let Some(db) = error.downcast_ref::<postgres::Error>() else {
        return true;
    };
    match db.code().map(|c| c.code()) {
        None => true,
        Some(c) => {
            c.starts_with("08")
                || matches!(
                    c,
                    "40001" | "40P01" | "53300" | "55P03" | "57014" | "57P01" | "57P03"
                )
        }
    }
}

fn exact_leaf(served: &Value, job: &str, generation: i64) -> bool {
    served["generation"].as_i64() == generation.checked_add(1)
        && served["bundle"]["root"].as_str().is_some_and(|root| {
            served["bundle"]["artifacts"]
                .as_array()
                .is_some_and(|artifacts| {
                    artifacts
                        .iter()
                        .any(|a| a["artifact_id"] == root && a["job_id"] == job)
                })
        })
}

/// Additional graph rows, indexed by this job. The root pays the graph request
/// once; each consumer pays its edges. Logical row bytes are doubled and a
/// per-row allowance covers indexes/page overhead. This remains an estimate,
/// not a measurement of global table allocation or WAL.
pub fn measure_records(tx: &mut postgres::Transaction<'_>, env: &str, job: &str) -> Result<u64> {
    let r=tx.query_one("WITH node AS (SELECT n.* FROM delphi_graph_nodes n JOIN polis_queue_jobs q USING(env,job_id) WHERE n.env=$1 AND n.job_id=$2::text::uuid AND q.stage LIKE 'graph_%'), sizes AS (SELECT pg_column_size(n)::bigint AS bytes FROM node n UNION ALL SELECT pg_column_size(g)::bigint FROM delphi_graphs g JOIN node n ON g.env=n.env AND g.graph_id=n.graph_id AND g.root_job_id=n.job_id UNION ALL SELECT pg_column_size(e)::bigint FROM delphi_graph_edges e JOIN node n ON e.env=n.env AND e.consumer=n.job_id UNION ALL SELECT pg_column_size(a)::bigint FROM delphi_artifacts a JOIN node n USING(env,job_id)) SELECT coalesce(sum(bytes*2+512),0)::bigint FROM sizes", &[&env,&job])?;
    Ok(r.try_get::<_, i64>(0)?.max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provenance_subprocess_is_killed_on_deadline_or_output_bound() -> Result<()> {
        let mut hangs = Command::new("sh");
        hangs.args(["-c", "exec sleep 20"]);
        let start = Instant::now();
        assert!(bounded_output(hangs, Duration::from_millis(30)).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut floods = Command::new("sh");
        floods.args(["-c", "exec yes x"]);
        assert!(bounded_output(floods, Duration::from_secs(2)).is_err());
        let mut succeeds = Command::new("sh");
        succeeds.args(["-c", "printf '{}'"]);
        assert_eq!(bounded_output(succeeds, Duration::from_secs(2))?, b"{}");
        Ok(())
    }

    #[test]
    fn empty_list_is_off_even_with_invalid_graph_settings() -> Result<()> {
        let get = |k: &str| match k {
            "DELPHI_SHADOW_GRAPH_ENV" => Some("served".into()),
            _ => None,
        };
        assert_eq!(
            Config::load(&get, "shadow-delphi-1").map_err(|e| anyhow::anyhow!(e.0))?,
            None
        );
        Ok(())
    }
    #[test]
    fn explicit_list_requires_a_separate_shadow_env() -> Result<()> {
        for env in ["served", "shadow-delphi-1", "shadow-"] {
            let get = |k: &str| match k {
                "DELPHI_SHADOW_GRAPH_CONVERSATIONS" => Some("demo1,demo1 demo2".into()),
                "DELPHI_SHADOW_GRAPH_ENV" => Some(env.into()),
                _ => None,
            };
            assert!(Config::load(&get, "shadow-delphi-1").is_err());
        }
        let get = |k: &str| {
            (k == "DELPHI_SHADOW_GRAPH_CONVERSATIONS").then(|| "demo1,demo1 demo2".into())
        };
        let c = Config::load(&get, "shadow-delphi-1")
            .map_err(|e| anyhow::anyhow!(e.0))?
            .ok_or_else(|| anyhow::anyhow!("graph disabled"))?;
        assert_eq!(c.codes, ["demo1", "demo2"]);
        assert_eq!(c.env, "shadow-graph-1");
        Ok(())
    }
    #[test]
    fn embedding_selection_is_per_environment_and_explicit() -> Result<()> {
        for (selection, expected) in [("{}".to_owned(), default_model()?.to_owned()),
            (json!({"other":Model::MiniLm.definition().map_err(anyhow::Error::msg)?.model}).to_string(), default_model()?.to_owned()),
            (json!({"shadow-graph-1":Model::MiniLm.definition().map_err(anyhow::Error::msg)?.model}).to_string(), Model::MiniLm.definition().map_err(anyhow::Error::msg)?.model.clone())] {
            let get = |key: &str| match key {
                "DELPHI_SHADOW_GRAPH_CONVERSATIONS" => Some("demo1".into()),
                "DELPHI_EMBED_MODEL_BY_ENV" => Some(selection.clone()),
                _ => None,
            };
            let cfg=Config::load(&get,"shadow-delphi-1").map_err(|e|anyhow::anyhow!(e.0))?.ok_or_else(||anyhow::anyhow!("disabled"))?;
            assert_eq!(cfg.embedding_model,expected);
        }
        Ok(())
    }
    #[test]
    fn specification_binds_four_steps_and_refuses_large_input() -> Result<()> {
        let mut s = Snapshot {
            ids: (0..5).collect(),
            texts: vec!["public fixture comment".into(); 5],
            digest: "d".repeat(64),
        };
        let p = json!({"code":"a".repeat(64),"runtime":"python-3.12.0","adapter_sha256":"b".repeat(64),"model_sha256":"c".repeat(64)});
        let v = spec(&s, &"e".repeat(64), &p)?;
        assert_eq!(v["nodes"].as_array().map(Vec::len), Some(4));
        assert_eq!(v["nodes"][0]["declared"]["model"], default_model()?);
        assert_eq!(
            v["nodes"][3]["declared"]["model"],
            "delphi-keyword-labels/1"
        );
        assert_eq!(v["nodes"][2]["inputs"][0]["node"], "graph_cluster");
        s.texts = vec!["x".repeat(4096); 2000];
        s.ids = (0..2000).collect();
        assert!(spec(&s, &"e".repeat(64), &p).is_err());
        Ok(())
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn publication_requires_exact_root_and_generation() {
        let mut served = json!({"generation": 7,"bundle":{"root":"root","artifacts":[
            {"artifact_id":"ancestor","job_id":"requested"},
            {"artifact_id":"root","job_id":"other"}]}});
        assert!(!exact_leaf(&served, "requested", 6));
        served["bundle"]["root"] = json!("ancestor");
        assert!(exact_leaf(&served, "requested", 6));
        assert!(!exact_leaf(&served, "requested", 5));
        assert!(!exact_leaf(&Value::Null, "requested", 6));
    }
    #[test]
    fn old_refusal_and_new_code_are_reconsidered() -> Result<()> {
        let live = Live {
            zid: 1,
            comments: 2001,
            last_modified: 2,
        };
        let old: Observation = serde_json::from_value(json!({"comments":2001,"last_modified":2}))?;
        assert_ne!(old, Observation::new(&live, "build-a"));
        assert_ne!(
            Observation::new(&live, "build-a"),
            Observation::new(&live, "build-b")
        );
        Ok(())
    }
}
