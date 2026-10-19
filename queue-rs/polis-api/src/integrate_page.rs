//! Integration admin HTML through the bounded static transport.
use crate::{
    admin_page,
    http::{Outgoing, Request},
    route::{self, App, Res},
};
#[path = "../../polis-contracts/src/integrate_page.rs"]
mod contract;

pub fn matches(path: &str) -> bool {
    // Express's optional suffix has no end anchor: /integrateSuffix also matches.
    path.starts_with("/integrate")
}
pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
    if app.integrate_page.is_none() || !matches(req.path()) || !admin_page::admitted(req) {
        return None;
    }
    Some(contract::Request {
        path: req.path().into(),
        head_only: req.method == "HEAD",
    })
}
pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(_request) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Some(client) = app.integrate_page.as_ref() else {
        return route::bad_gateway();
    };
    let Ok((html, chunks)) = admin_page::html(client, req).await else {
        return route::bad_gateway();
    };
    let _response = contract::Response { html };
    route::admin_html(req, res, chunks)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn express_prefix_boundary() {
        for p in [
            "/integrate",
            "/integrate/",
            "/integrate/nested",
            "/integrateSuffix",
            "/integrate-more",
        ] {
            assert!(matches(p), "{p}");
        }
        for p in [
            "/integrat",
            "/Integrate",
            "/prefix/integrate",
            "/other-conversations",
            "/m/2fixture",
        ] {
            assert!(!matches(p), "{p}");
        }
    }
}
