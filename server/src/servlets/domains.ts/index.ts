

function isParentDomainWhitelisted(
  domain: string,
  zid: any,
  isWithinIframe: any,
  domain_whitelist_override_key: any
) {
  return pgQueryP_readOnly(
    "select * from site_domain_whitelist where site_id = " +
      "(select site_id from users where uid = " +
      "(select owner from conversations where zid = ($1)));",
    [zid]
  ).then(function (rows: string | any[]) {
    console.log("isParentDomainWhitelisted", domain, zid, isWithinIframe);
    if (!rows || !rows.length || !rows[0].domain_whitelist.length) {
      // there is no whitelist, so any domain is ok.
      console.log("isParentDomainWhitelisted", "no whitelist");
      return true;
    }
    const whitelist = rows[0].domain_whitelist;
    const wdomains = whitelist.split(",");
    if (!isWithinIframe && wdomains.indexOf("*.pol.is") >= 0) {
      // if pol.is is in the whitelist, then it's ok to show the conversation outside of an iframe.
      console.log("isParentDomainWhitelisted", "*.pol.is");
      return true;
    }
    if (
      domain_whitelist_override_key &&
      rows[0].domain_whitelist_override_key === domain_whitelist_override_key
    ) {
      return true;
    }
    let ok = false;
    console.log("isParentDomainWhitelisted", 1);
    for (let i = 0; i < wdomains.length; i++) {
      const w = wdomains[i];
      let wParts = w.split(".");

      // example: domain might be blogs.nytimes.com, and whitelist entry might be *.nytimes.com, and that should be a match
      let parts = domain.split(".");

      console.log("isParentDomainWhitelisted", 2, wParts, parts);
      if (wParts.length && wParts[0] === "*") {
        // wild card case
        // check for a match on each part following the '*'
        let bad = false;

        wParts = wParts.reverse();
        parts = parts.reverse();
        console.log("isParentDomainWhitelisted", 3, parts, wParts);
        for (let p = 0; p < wParts.length - 1; p++) {
          console.log("isParentDomainWhitelisted", 33, parts[p], wParts[p]);
          if (wParts[p] !== parts[p]) {
            bad = true;
            console.log("isParentDomainWhitelisted", 4);
            break;
          }
        }
        ok = !bad;
      } else {
        // no wild card
        let bad2 = false;
        console.log("isParentDomainWhitelisted", 5);
        if (wParts.length !== parts.length) {
          console.log("isParentDomainWhitelisted", 6);
          bad2 = true;
        }
        console.log("isParentDomainWhitelisted", 61, parts, wParts);
        // check for a match on each part
        for (let p2 = 0; p2 < wParts.length; p2++) {
          console.log("isParentDomainWhitelisted", 66, parts[p2], wParts[p2]);
          if (wParts[p2] !== parts[p2]) {
            bad2 = true;
            console.log("isParentDomainWhitelisted", 7);
            break;
          }
        }
        ok = !bad2;
      }

      if (ok) {
        break;
      }
    }
    console.log("isParentDomainWhitelisted", 8, ok);
    return ok;
  });
}

function denyIfNotFromWhitelistedDomain(
  req: {
    headers?: { referrer: string };
    p: { zid: any; domain_whitelist_override_key: any };
  },
  res: { send: (arg0: number, arg1: string) => void },
  next: (arg0?: string) => void
) {
  const isWithinIframe =
    req.headers &&
    req.headers.referrer &&
    req.headers.referrer.includes("parent_url");

  const ref = req?.headers?.referrer;
  let refParts: string[] = [];
  let resultRef = "";
  if (isWithinIframe) {
    if (ref) {
      const decodedRefString = decodeURIComponent(
        ref.replace(/.*parent_url=/, "").replace(/&.*/, "")
      );
      if (decodedRefString && decodedRefString.length)
        refParts = decodedRefString.split("/");
      resultRef = (refParts && refParts.length >= 3 && refParts[2]) || "";
    }
  } else {
    if (ref && ref.length) refParts = ref.split("/");
    if (refParts && refParts.length >= 3) resultRef = refParts[2] || "";
  }

  const zid = req.p.zid;

  isParentDomainWhitelisted(
    resultRef,
    zid,
    isWithinIframe,
    req.p.domain_whitelist_override_key
  )
    .then(function (isOk: any) {
      if (isOk) {
        next();
      } else {
        res.send(403, "polis_err_domain");
        next("polis_err_domain");
      }
    })
    .catch(function (err: any) {
      console.error(err);
      res.send(403, "polis_err_domain");
      next("polis_err_domain_misc");
    });
}

function setDomainWhitelist(uid?: any, newWhitelist?: any) {
  // TODO_UPSERT
  return pgQueryP(
    "select * from site_domain_whitelist where site_id = (select site_id from users where uid = ($1));",
    [uid]
  ).then(function (rows: string | any[]) {
    if (!rows || !rows.length) {
      return pgQueryP(
        "insert into site_domain_whitelist (site_id, domain_whitelist) values ((select site_id from users where uid = ($1)), $2);",
        [uid, newWhitelist]
      );
    } else {
      return pgQueryP(
        "update site_domain_whitelist set domain_whitelist = ($2) where site_id = (select site_id from users where uid = ($1));",
        [uid, newWhitelist]
      );
    }
  });
}

function getDomainWhitelist(uid?: any) {
  return pgQueryP(
    "select * from site_domain_whitelist where site_id = (select site_id from users where uid = ($1));",
    [uid]
  ).then(function (rows: string | any[]) {
    if (!rows || !rows.length) {
      return "";
    }
    return rows[0].domain_whitelist;
  });
}

function handle_GET_domainWhitelist(
  req: { p: { uid?: any } },
  res: { json: (arg0: { domain_whitelist: any }) => void }
) {
  getDomainWhitelist(req.p.uid)
    .then(function (whitelist: any) {
      res.json({
        domain_whitelist: whitelist,
      });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_get_domainWhitelist_misc", err);
    });
}

function handle_POST_domainWhitelist(
  req: { p: { uid?: any; domain_whitelist: any } },
  res: { json: (arg0: { domain_whitelist: any }) => void }
) {
  setDomainWhitelist(req.p.uid, req.p.domain_whitelist)
    .then(function () {
      res.json({
        domain_whitelist: req.p.domain_whitelist,
      });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_post_domainWhitelist_misc", err);
    });
}