//! Bodyless public comment reads. Authentication, moderation and report views
//! stay on Node through the existing 502 handoff until their contracts move.
use crate::{
    db,
    http::{Outgoing, Request},
    js::{Js, Obj},
    params,
    route::{self, App, Res},
};
use anyhow::Result;
use postgres::Client;

pub const PATH: &str = "/api/v3/comments";
#[derive(Clone, Debug)]
struct Query {
    cid: String,
    tids: Option<Vec<i32>>,
    moderation_value: Option<i32>,
    limit: i64,
    offset: i64,
    paginated: bool,
}
fn boolean(v: &Js) -> Option<bool> {
    match v {
        Js::Bool(v) => Some(*v),
        Js::Num(v) => Some(*v != 0.0),
        Js::Str(v) => match v.to_lowercase().as_str() {
            "t" | "true" | "on" | "1" => Some(true),
            "f" | "false" | "off" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}
fn integer(v: &Js) -> Option<i32> {
    let n = route::get_int(v)?;
    if n >= i32::MIN as f64 && n <= i32::MAX as f64 {
        Some(n as i32)
    } else {
        None
    }
}
impl Query {
    fn parse(req: &Request, body: &Js) -> Option<Self> {
        // Even a malformed credential belongs to Node's optional auth chain.
        if req.headers.get("authorization").is_some()
            || req.headers.get("cookie").is_some()
            || req.headers.get("content-length").is_some()
            || req.headers.get("transfer-encoding").is_some()
        {
            return None;
        }
        let p = params::merged(body, &params::parse_query(req.query().unwrap_or_default()));
        let present = |k: &str| p.get(k).filter(|v| !matches!(v, Js::Null));
        if present("report_id").is_some() {
            return None;
        }
        if let Some(v) = present("moderation")
            && boolean(v)?
        {
            return None;
        }
        for name in ["modIn", "include_voting_patterns"] {
            if let Some(v) = present(name) {
                boolean(v)?;
            }
        }
        for name in ["mod_gt", "pid"] {
            if let Some(v) = present(name) {
                integer(v)?;
            }
        }
        let Js::Str(cid) = present("conversation_id")? else {
            return None;
        };
        if cid.encode_utf16().count() > 100 {
            return None;
        }
        let tids = match present("tids") {
            None => None,
            Some(Js::Str(s)) => Some(s.split(',').map(|s| to_i32(&Js::Str(s.into()))).collect()),
            Some(Js::Arr(a)) => Some(a.iter().map(to_i32).collect()),
            _ => return None,
        };
        let moderation_value = present("mod").map(integer).transpose_option()?;
        let limit = present("limit").map(integer).transpose_option()?;
        let offset = present("offset")
            .map(integer)
            .transpose_option()?
            .unwrap_or(0);
        // Negative offset with no pagination is a database-error path on Node.
        if limit.is_none() && offset < 0 {
            return None;
        }
        Some(Self {
            cid: cid.trim_matches(' ').into(),
            tids,
            moderation_value,
            limit: i64::from(
                limit
                    .map(|n| if n <= 0 { 50 } else { n.min(500) })
                    .unwrap_or(999),
            ),
            offset: i64::from(offset.max(0)),
            paginated: limit.is_some(),
        })
    }
}
trait TransposeOption<T> {
    fn transpose_option(self) -> Option<Option<T>>;
}
impl<T> TransposeOption<T> for Option<Option<T>> {
    fn transpose_option(self) -> Option<Option<T>> {
        match self {
            None => Some(None),
            Some(Some(v)) => Some(Some(v)),
            Some(None) => None,
        }
    }
}
/// JavaScript Number(value) >> 0, used by getArrayOfInt (not getInt).
fn to_i32(v: &Js) -> i32 {
    if let Js::Bool(v) = v {
        return i32::from(*v);
    }
    let n = crate::js::string_to_number(&v.to_js_string());
    if !n.is_finite() || n == 0.0 {
        return 0;
    }
    n.trunc().rem_euclid(4294967296.0) as u32 as i32
}
const FILTER: &str = "zid=$1 AND active=true AND velocity>0 AND ($2::integer[] IS NULL OR tid=ANY($2)) AND ($3::integer IS NULL OR mod=$3) AND (($4::boolean AND mod=1) OR (NOT $4::boolean AND mod != -1))";
fn context(c: &mut Client, cid: &str) -> Result<Option<(i32, bool)>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(None);
    };
    let row = c.query_opt(
        "select strict_moderation from conversations where zid=$1",
        &[&zid],
    )?;
    Ok(row.map(|r| (zid, r.get::<_, Option<bool>>(0).unwrap_or(false))))
}
fn count(c: &mut Client, q: &Query, zid: i32, strict: bool) -> Result<i64> {
    Ok(c.query_one(
        &format!("select count(*) from comments where {FILTER}"),
        &[&zid, &q.tids, &q.moderation_value, &strict],
    )?
    .try_get(0)?)
}
fn rows(c: &mut Client, q: &Query, zid: i32, strict: bool) -> Result<Vec<Js>> {
    // SELECT * and the original created-only ordering retain Node's tied-row
    // behavior. A stronger ordering would be an observable contract change.
    let rows = c.query(
        &format!("select * from comments where {FILTER} order by created limit $5 offset $6"),
        &[
            &zid,
            &q.tids,
            &q.moderation_value,
            &strict,
            &q.limit,
            &q.offset,
        ],
    )?;
    rows.iter()
        .map(|r| {
            let mut o = Obj::new();
            o.set(
                "txt",
                r.try_get::<_, Option<String>>("txt")?
                    .map(Js::Str)
                    .unwrap_or(Js::Null),
            );
            o.set("tid", Js::Num(f64::from(r.try_get::<_, i32>("tid")?)));
            o.set(
                "created",
                r.try_get::<_, Option<i64>>("created")?
                    .map(|n| Js::Str(n.to_string()))
                    .unwrap_or(Js::Null),
            );
            o.set(
                "quote_src_url",
                r.try_get::<_, Option<String>>("quote_src_url")?
                    .map(Js::Str)
                    .unwrap_or(Js::Null),
            );
            for field in ["is_seed", "is_meta"] {
                o.set(
                    field,
                    r.try_get::<_, Option<bool>>(field)?
                        .map(Js::Bool)
                        .unwrap_or(Js::Null),
                );
            }
            o.set(
                "lang",
                r.try_get::<_, Option<String>>("lang")?
                    .map(Js::Str)
                    .unwrap_or(Js::Null),
            );
            o.set(
                "pid",
                r.try_get::<_, Option<i32>>("pid")?
                    .map(|n| Js::Num(f64::from(n)))
                    .unwrap_or(Js::Null),
            );
            o.set(
                "original_id",
                r.try_get::<_, Option<uuid::Uuid>>("original_id")?
                    .map(|v| Js::Str(v.to_string()))
                    .unwrap_or(Js::Null),
            );
            Ok(Js::Obj(o))
        })
        .collect()
}
pub(crate) async fn handle(app: &App, req: &Request, body: &Js, res: Res) -> Outgoing {
    let (Some(pool), Some(read_pool), Some(q)) = (
        &app.comments_db,
        &app.comments_count_db,
        Query::parse(req, body),
    ) else {
        return route::bad_gateway();
    };
    let cid = q.cid.clone();
    let ctx = pool.with(move |c| context(c, &cid)).await;
    let Ok(Some((zid, strict))) = ctx else {
        return route::bad_gateway();
    };
    let total = if q.paginated {
        let copy = q.clone();
        match read_pool.with(move |c| count(c, &copy, zid, strict)).await {
            Ok(n) => Some(n),
            Err(_) => return route::bad_gateway(),
        }
    } else {
        None
    };
    let copy = q.clone();
    let Ok(values) = pool.with(move |c| rows(c, &copy, zid, strict)).await else {
        return route::bad_gateway();
    };
    let payload = if let Some(total) = total {
        let mut pagination = Obj::new();
        pagination.set("limit", Js::Num(q.limit as f64));
        pagination.set("offset", Js::Num(q.offset as f64));
        pagination.set("total", Js::Num(total as f64));
        pagination.set("hasMore", Js::Bool(q.offset + q.limit < total));
        let mut result = Obj::new();
        result.set("comments", Js::Arr(values));
        result.set("pagination", Js::Obj(pagination));
        Js::Obj(result)
    } else {
        Js::Arr(values)
    };
    route::json(req, res, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Headers;
    fn request(query: &str) -> Request {
        Request {
            method: "GET".into(),
            target: format!("{PATH}?{query}"),
            headers: Headers::default(),
            body: vec![],
        }
    }
    #[test]
    fn public_query_parsing_keeps_legacy_and_paginated_rules() {
        let q = Query::parse(
            &request("conversation_id=abc&limit=0&offset=-2&tids=1,0x2,bad&mod=0"),
            &Js::Null,
        )
        .unwrap();
        assert_eq!(q.limit, 50);
        assert_eq!(q.offset, 0);
        assert!(q.paginated);
        assert_eq!(q.tids, Some(vec![1, 2, 0]));
        assert_eq!(q.moderation_value, Some(0));
        let q = Query::parse(
            &request("conversation_id=abc&offset=2&unknown=x"),
            &Js::Null,
        )
        .unwrap();
        assert!(!q.paginated);
        assert_eq!(q.limit, 999);
        assert_eq!(q.offset, 2);
        assert_eq!(to_i32(&Js::Bool(true)), 1);
        assert_eq!(to_i32(&Js::Str("4294967297".into())), 1);
    }
    #[test]
    fn unmoved_boundaries_return_to_node_before_database_work() {
        for query in [
            "",
            "conversation_id=abc&moderation=true",
            "conversation_id=abc&report_id=x",
            "conversation_id=abc&limit[]=1",
            "conversation_id=abc&mod=bad",
            "conversation_id=abc&offset=-1",
            "conversation_id=abc&modIn=bad",
        ] {
            assert!(
                Query::parse(&request(query), &Js::Null).is_none(),
                "{query}"
            );
        }
        for name in [
            "authorization",
            "cookie",
            "content-length",
            "transfer-encoding",
        ] {
            let mut req = request("conversation_id=abc");
            req.headers = Headers::from_raw([(name, "value")]);
            assert!(Query::parse(&req, &Js::Null).is_none(), "{name}");
        }
    }
    #[cfg(feature = "db-tests")]
    #[test]
    fn typed_comment_queries_preserve_visibility_projection_and_pagination() {
        let url =
            std::env::var("POLIS_API_TEST_DATABASE_URL").expect("db-tests requires PostgreSQL");
        let mut c = Client::connect(&url, postgres::NoTls).unwrap();
        let schema = format!("comment_read_test_{}", std::process::id());
        c.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path={schema};
        CREATE TABLE zinvites(zid integer,zinvite text);
        CREATE TABLE conversations(zid integer,strict_moderation boolean);
        CREATE TABLE comments(zid integer,tid integer,txt text,created bigint,quote_src_url text,is_seed boolean,is_meta boolean,lang text,pid integer,original_id uuid,active boolean,velocity real,mod integer);
        INSERT INTO zinvites VALUES(1,'abc'); INSERT INTO conversations VALUES(1,false);
        INSERT INTO comments VALUES
        (1,0,'pending',10,null,true,false,'en',0,null,true,1,0),
        (1,1,'approved',20,null,false,false,'en',1,'11111111-2222-4333-8444-555555555555',true,1,1),
        (1,2,'hidden',30,null,false,false,'en',2,null,true,1,-1),
        (1,3,'inactive',40,null,false,false,'en',3,null,false,1,1),
        (1,4,'muted',50,null,false,false,'en',4,null,true,0,1);" )).unwrap();
        assert_eq!(context(&mut c, "abc").unwrap(), Some((1, false)));
        assert_eq!(context(&mut c, "absent").unwrap(), None);
        let q = Query::parse(&request("conversation_id=abc&limit=1&offset=1"), &Js::Null).unwrap();
        assert_eq!(count(&mut c, &q, 1, false).unwrap(), 2);
        assert_eq!(count(&mut c, &q, 1, true).unwrap(), 1);
        let selected = rows(&mut c, &q, 1, false).unwrap();
        assert_eq!(selected.len(), 1);
        let o = selected[0].as_obj().unwrap();
        assert_eq!(o.get("created"), Some(&Js::Str("20".into())));
        assert_eq!(
            o.get("original_id"),
            Some(&Js::Str("11111111-2222-4333-8444-555555555555".into()))
        );
        assert!(o.get("zid").is_none());
        assert!(o.get("uid").is_none());
        let q = Query::parse(&request("conversation_id=abc&tids=0"), &Js::Null).unwrap();
        assert_eq!(rows(&mut c, &q, 1, false).unwrap().len(), 1);
        assert!(rows(&mut c, &q, 1, true).unwrap().is_empty());
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    }
}
