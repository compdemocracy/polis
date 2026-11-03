//! Checks the duplicated catalog against real dispatch and startup source.
//! These source checks recognize module-qualified PATH constants, ::matches
//! predicates and literal outer paths. They do not infer method branches inside
//! an existing path, differently named constants, or arbitrary predicate changes.
//! Switch discovery follows the current _READS/_WRITES and four explicit names;
//! new lookup syntax needs a corresponding scanner update. Treevite operation
//! paths are checked separately against its current from_path match arms.
use super::*;
use crate::{config, db, http, route};
use std::{cell::RefCell, collections::BTreeSet, panic::Location, sync::Arc, time::Duration};

tokio::task_local! {
    static HANDBACK: RefCell<Option<&'static Location<'static>>>;
}

// No observer exists in a non-test build. Task-local storage keeps concurrently
// running tests independent, including when Tokio moves a task between threads.
pub(crate) fn observe_handback(site: &'static Location<'static>) {
    let _ = HANDBACK.try_with(|slot| *slot.borrow_mut() = Some(site));
}

fn app() -> Arc<route::App> {
    let cfg = config::Config {
        listen: String::new(),
        math_env: "python".into(),
        cache_size: 1,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: db::Limits {
            size: 1,
            acquire_timeout: Duration::from_millis(20),
            statement_timeout: Duration::from_millis(20),
            max_lifetime: Duration::from_secs(60),
        },
    };
    // No database fixtures or credentials. Only /health attempts a connection;
    // the closed loopback port makes it report degraded health.
    let pg = "postgresql://test@127.0.0.1:1/test".parse().unwrap();
    let pool = db::Pool::new(
        polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(pg)),
        cfg.pool.clone(),
    );
    Arc::new(route::App::new(&cfg, pool))
}

async fn probe(
    app: Arc<route::App>,
    method: &str,
    path: &str,
) -> (http::Outgoing, Option<&'static Location<'static>>) {
    let request = http::Request {
        method: method.into(),
        target: path.into(),
        headers: http::Headers::default(),
        body: Vec::new(),
    };
    HANDBACK
        .scope(RefCell::new(None), async {
            let response = crate::dispatch(app, None, request).await;
            (response, HANDBACK.with(|slot| *slot.borrow()))
        })
        .await
}

#[tokio::test]
async fn every_catalog_method_and_path_reaches_its_dispatch_family() {
    let app = app();
    // Prove that the observer distinguishes the otherwise identical 502 from
    // the outer fallthrough, rather than accepting every 502 as a matched route.
    let (response, site) = probe(app.clone(), "GET", "/not-a-route").await;
    assert_eq!(response.status, 502);
    assert!(site.unwrap().file().ends_with("main.rs"));
    for route in ROUTES {
        for method in route.methods {
            let (response, site) = probe(app.clone(), method, route.example).await;
            match route.family {
                "health" => {
                    assert_eq!(response.status, 503);
                    assert!(site.is_none());
                    let http::Body::Fixed(body) = response.body else {
                        panic!("health JSON")
                    };
                    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(value["status"], "degraded");
                }
                "owner" => {
                    assert_eq!(response.status, 503);
                    assert!(site.is_none());
                }
                "route" => {
                    assert_eq!(
                        response.status, 400,
                        "pca2 validates the missing conversation"
                    );
                    assert!(site.is_none());
                }
                family => {
                    assert_eq!(response.status, 502, "{method} {}", route.example);
                    let site = site.expect("disabled family must hand back");
                    assert!(
                        !site.file().ends_with("main.rs"),
                        "{method} {} fell through",
                        route.example
                    );
                    if site.file().ends_with("route.rs") {
                        let prefix = include_str!("route.rs")
                            .lines()
                            .take(site.line() as usize)
                            .collect::<Vec<_>>()
                            .join("\n");
                        let condition =
                            prefix.rsplit_once("\n    if ").expect("family condition").1;
                        assert!(
                            condition.contains(&format!("crate::{family}::")),
                            "{method} {}: wrong family {family} at {site}: {condition}",
                            route.example
                        );
                    } else {
                        assert!(
                            site.file().ends_with(&format!("/{family}.rs")),
                            "{method} {}: wrong family {family} at {site}",
                            route.example
                        );
                    }
                }
            }
        }
    }
}

fn compact(source: &str) -> String {
    source
        .lines()
        .map(|line| line.split_once("//").map_or(line, |(code, _)| code))
        .flat_map(str::chars)
        .filter(|c| !c.is_whitespace())
        .collect()
}

fn dispatch_keys(source: &str) -> BTreeSet<String> {
    let body = source
        .split_once("async fn dispatch_at_clock(")
        .unwrap()
        .1
        .split_once("#[tokio::main]")
        .unwrap()
        .0;
    // Check the actual outer match, not a second hand-maintained path list.
    // A new constant arm, literal path or predicate must have a catalog entry.
    let body = body
        .lines()
        .map(|line| line.split_once("//").map_or(line, |(code, _)| code))
        .collect::<Vec<_>>()
        .join("\n");
    let mut keys = BTreeSet::new();
    for token in
        body.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':' || c == '/'))
    {
        if token.contains("::") && (token.ends_with("PATH") || token.ends_with("::matches")) {
            keys.insert(token.to_owned());
        }
        if token.starts_with('/') && token.len() > 1 {
            keys.insert(token.to_owned());
        }
    }
    keys
}

#[test]
fn catalog_covers_every_outer_dispatch_arm() {
    let expected = dispatch_keys(include_str!("main.rs"));
    let actual: BTreeSet<_> = ROUTES.iter().map(|r| r.dispatch_key.to_owned()).collect();
    assert_eq!(actual, expected);
    for key in &expected {
        let family = key.split_once("::").map_or("health", |(module, _)| module);
        assert!(
            ROUTES
                .iter()
                .any(|r| r.dispatch_key == key && r.family == family),
            "missing primary family {family} for dispatch key {key}"
        );
    }
    let source = compact(include_str!("../../polis-contracts/src/treevite_write.rs"));
    let arms = source
        .split_once("pubfnfrom_path(")
        .unwrap()
        .1
        .split_once("pubfnfield(")
        .unwrap()
        .0;
    let mut expected_treevite = BTreeSet::new();
    for arm in arms.split(',') {
        let Some((prefix, _)) = arm.split_once("=>Some(Self::") else {
            continue;
        };
        let name = prefix.rsplit('{').next().unwrap();
        assert!(
            name.ends_with("_PATH"),
            "update Treevite path scanner for {name}"
        );
        let declaration = format!("pubconst{name}:&str=\"");
        let value = source
            .split_once(&declaration)
            .unwrap()
            .1
            .split('"')
            .next()
            .unwrap();
        assert!(crate::treevite_write_contract::Operation::from_path(value).is_some());
        expected_treevite.insert(value);
    }
    assert!(!expected_treevite.is_empty());
    let actual_treevite: BTreeSet<_> = ROUTES
        .iter()
        .filter(|r| r.dispatch_key == "treevite_write::matches" && r.family == "treevite_write")
        .map(|r| r.path)
        .collect();
    assert_eq!(
        actual_treevite, expected_treevite,
        "Treevite operation coverage"
    );
    // Demonstrate that this check notices an uncatalogued literal route too.
    let mutant =
        include_str!("main.rs").replace("owner::PATH =>", "\"/new-route\" | owner::PATH =>");
    assert_ne!(actual, dispatch_keys(&mutant));
    let mut methods = BTreeSet::new();
    for route in ROUTES {
        for method in route.methods {
            assert!(
                methods.insert((route.path, method)),
                "duplicate method/path"
            );
        }
    }
}

#[test]
fn catalog_switches_are_real_startup_reads() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut read_switches = BTreeSet::new();
    let mut module_reads = std::collections::BTreeMap::<String, BTreeSet<String>>::new();
    for path in std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
    {
        if path.extension().and_then(|s| s.to_str()) != Some("rs")
            || path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("startup_routes")
        {
            continue;
        }
        let family = path.file_stem().unwrap().to_str().unwrap().to_owned();
        let source = std::fs::read_to_string(path).unwrap();
        let source = compact(
            source
                .split("mod tests {")
                .next()
                .unwrap()
                .split("mod health_tests {")
                .next()
                .unwrap(),
        );
        for call in ["std::env::var(\"", "from_env_for(\""] {
            for tail in source.split(call).skip(1) {
                let name = tail.split('"').next().unwrap();
                if name.starts_with("POLIS_API_")
                    && (name.ends_with("_READS")
                        || name.ends_with("_WRITES")
                        || [
                            "POLIS_API_OWNER_LIST",
                            "POLIS_API_POST_VOTES",
                            "POLIS_API_POST_TREEVITE_WAVES",
                            "POLIS_API_TREEVITE_WRITE",
                        ]
                        .contains(&name))
                {
                    read_switches.insert(name.to_owned());
                    module_reads
                        .entry(family.clone())
                        .or_default()
                        .insert(name.to_owned());
                }
            }
        }
    }
    let main = compact(include_str!("main.rs"));
    // The conversation-page reader is the one loop-based lookup. Check its
    // source shape explicitly; do not count a name merely mentioned in a comment.
    assert!(main.contains("for(i,switch)in[\"POLIS_API_CONVERSATION_PAGE_READS\"].into_iter().enumerate(){ifstd::env::var(switch).ok().as_deref()==Some(\"1\")"));
    read_switches.insert("POLIS_API_CONVERSATION_PAGE_READS".into());
    // This switch requires signing keys at boot; it is not a route enable flag.
    assert!(read_switches.remove("POLIS_API_PARTICIPANT_READS"));
    let catalog: BTreeSet<_> = ROUTES
        .iter()
        .flat_map(|r| r.switches.iter().map(|s| (*s).to_owned()))
        .collect();
    assert_eq!(catalog, read_switches);
    for route in ROUTES {
        for switch in route.switches {
            let local = module_reads
                .get(route.family)
                .is_some_and(|reads| reads.contains(*switch));
            assert!(
                local || startup_read_belongs(&main, switch, route.family),
                "switch {switch} has no reader for family {}",
                route.family
            );
        }
    }
}

// Match a current startup assignment or the block controlled by its lookup.
// This is intentionally a source-shape check, not a Rust parser.
fn startup_read_belongs(main: &str, switch: &str, family: &str) -> bool {
    let direct = format!("std::env::var(\"{switch}\")");
    let call = if main.contains(&direct) {
        direct
    } else {
        format!("from_env_for(\"{switch}\")")
    };
    let region = if switch == "POLIS_API_CONVERSATION_PAGE_READS" {
        main.split_once("for(i,switch)in[")
            .unwrap()
            .1
            .split_once("state.post_votes=")
            .unwrap()
            .0
    } else {
        let Some((before, after)) = main.split_once(&call) else {
            return false;
        };
        if before.ends_with("if") {
            let Some((_, body)) = after.split_once('{') else {
                return false;
            };
            let mut depth = 1;
            let mut end = body.len();
            for (i, c) in body.char_indices() {
                match c {
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
                if depth == 0 {
                    end = i;
                    break;
                }
            }
            &body[..end]
        } else {
            // Simple state assignments, including ops configured(...) calls.
            let start = before.rfind(';').map_or(0, |i| i + 1);
            let end = before.len() + call.len() + after.find(';').unwrap();
            &main[start..end]
        }
    };
    region.contains(&format!("{family}::")) || region.contains(&format!("state.{family}"))
}
