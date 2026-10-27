// NOTE: this isn't optimal
// rather than code for a new URL scheme for implicit conversations,
// the idea is to redirect implicitly created conversations
// to their zinvite based URL after creating the conversation.
// To improve conversation load time, this should be changed so that it
// does not redirect, and instead serves up the index.
// The routers on client and server will need to be updated for that

import _ from "underscore";
import type { PoolClient } from "pg";
import { getEmbedId } from "../utils/parameter";
import { buildConversationUrl } from "../server-helpers";
import { ConversationType, ExpressResponse } from "../d";
import { failJson } from "../utils/fail";
import { generateAndRegisterZinvite } from "../auth";
import { getZinvite } from "../utils/zinvite";
import { sendMultipleTextEmails } from "../email/senders";
import { sql_conversations } from "../db/sql";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import {
  ifDefinedSet,
  isDuplicateKey,
  isUserAllowedToCreateConversations,
} from "../utils/common";

// Response type that requires redirect method
type ImplicitConversationResponse = ExpressResponse & {
  redirect: (url: string) => void;
};

function buildConversationDemoUrl(req: any, zinvite: string) {
  return Config.getServerNameWithProtocol(req) + "/demo/" + zinvite;
}

function buildModerationUrl(req: any, zinvite: string) {
  return Config.getServerNameWithProtocol(req) + "/m/" + zinvite;
}

function buildSeedUrl(req: any, zinvite: string) {
  return buildModerationUrl(req, zinvite) + "/comments/seed";
}

function registerPageId(
  client: PoolClient,
  site_id: string,
  page_id: string,
  zid: number
) {
  return client.query(
    "insert into page_ids (site_id, page_id, zid) values ($1, $2, $3);",
    [site_id, page_id, zid]
  );
}

class MissingSiteOwnerError extends Error {
  constructor() {
    super("polis_err_bad_site_id");
  }
}

async function initializeImplicitConversation(
  site_id: string,
  page_id: string,
  o: ConversationType
) {
  const rows = (await pg.queryP_readOnly(
    "select uid from users where site_id = ($1) and site_owner = TRUE;",
    [site_id]
  )) as { uid: number }[];
  if (!rows?.length) throw new MissingSiteOwnerError();
  const uid = rows[0].uid;
  await new Promise<void>((resolve, reject) => {
    isUserAllowedToCreateConversations(uid, (err: any, isAllowed: boolean) => {
      if (err) return reject(err);
      if (!isAllowed)
        return reject(new Error("polis_err_create_implicit_forbidden"));
      resolve();
    });
  });

  try {
    return await pg.withTransaction(async (client) => {
      const params = Object.assign({}, o, {
        owner: uid,
        org_id: uid,
        is_active: true,
        is_draft: false,
        is_public: true,
        is_anon: false,
        profanity_filter: true,
        spam_filter: true,
        strict_moderation: false,
        owner_sees_participation_stats: false,
      });
      const q = sql_conversations.insert(params).returning("*").toString();
      const { rows } = await client.query(q);
      const zid = rows[0].zid;
      await registerPageId(client, site_id, page_id, zid);
      const zinvite = await generateAndRegisterZinvite(zid, false, client);
      return { zinvite, created: true };
    });
  } catch (err: any) {
    if (
      isDuplicateKey(err) &&
      err.constraint === "page_ids_site_id_page_id_key"
    ) {
      // The losing transaction has rolled back, including its conversation.
      // Read the committed winner on the primary, avoiding replica lag.
      const winners = (await pg.queryP(
        `SELECT z.zinvite FROM page_ids p JOIN zinvites z ON z.zid = p.zid
         WHERE p.site_id = $1 AND p.page_id = $2`,
        [site_id, page_id]
      )) as { zinvite: string }[];
      if (winners.length)
        return { zinvite: winners[0].zinvite, created: false };
    }
    throw err;
  }
}

// as will checks like isParticipationView on the client.
async function handle_GET_implicit_conversation_generation(
  req: {
    path: string;
    p: {
      demo: any;
      ucv: any;
      ucw: any;
      ucsh: any;
      ucst: any;
      ucsd: any;
      ucsv: any;
      ucsf: any;
      ui_lang: any;
      subscribe_type: any;
      xid: any;
      x_name: any;
      x_profile_image_url: any;
      x_email: any;
      parent_url: any;
      dwok: any;
      show_vis: any;
      bg_white: any;
      show_share: any;
      referrer: any;
    };
    headers?: { origin: string };
  },
  res: ImplicitConversationResponse
) {
  const site_id_match = /polis_site_id[^\/]*/.exec(req.path) || null;
  const page_id_match = /\S\/([^\/]*)/.exec(req.path) || null;
  let site_id: string;
  let page_id: string;
  try {
    site_id = await getEmbedId(site_id_match?.[0], "site_id");
    page_id = await getEmbedId(page_id_match?.[1], "page_id");
  } catch (err: any) {
    failJson(res, 400, err.message, err);
    return;
  }

  const demo = req.p.demo;
  const ucv = req.p.ucv;
  const ucw = req.p.ucw;
  const ucsh = req.p.ucsh;
  const ucst = req.p.ucst;
  const ucsd = req.p.ucsd;
  const ucsv = req.p.ucsv;
  const ucsf = req.p.ucsf;
  const ui_lang = req.p.ui_lang;
  const subscribe_type = req.p.subscribe_type;
  const xid = req.p.xid;
  const x_name = req.p.x_name;
  const x_profile_image_url = req.p.x_profile_image_url;
  const x_email = req.p.x_email;
  const parent_url = req.p.parent_url;
  const dwok = req.p.dwok;
  const referrer = req.p.referrer;
  const o: ConversationType = {};
  ifDefinedSet("parent_url", req.p, o);
  ifDefinedSet("auth_opt_allow_3rdparty", req.p, o);
  ifDefinedSet("topic", req.p, o);
  if (!_.isUndefined(req.p.show_vis)) {
    o.vis_type = req.p.show_vis ? 1 : 0;
  }
  if (!_.isUndefined(req.p.bg_white)) {
    o.bgcolor = req.p.bg_white ? "#fff" : null;
  }

  function appendParams(url: string) {
    // These are needed to disambiguate postMessages from multiple polis conversations embedded on one page.
    url += "?site_id=" + site_id + "&page_id=" + page_id;
    if (!_.isUndefined(ucv)) {
      url += "&ucv=" + ucv;
    }
    if (!_.isUndefined(ucw)) {
      url += "&ucw=" + ucw;
    }
    if (!_.isUndefined(ucst)) {
      url += "&ucst=" + ucst;
    }
    if (!_.isUndefined(ucsd)) {
      url += "&ucsd=" + ucsd;
    }
    if (!_.isUndefined(ucsv)) {
      url += "&ucsv=" + ucsv;
    }
    if (!_.isUndefined(ucsf)) {
      url += "&ucsf=" + ucsf;
    }
    if (!_.isUndefined(ui_lang)) {
      url += "&ui_lang=" + ui_lang;
    }
    if (!_.isUndefined(ucsh)) {
      url += "&ucsh=" + ucsh;
    }
    if (!_.isUndefined(subscribe_type)) {
      url += "&subscribe_type=" + subscribe_type;
    }
    if (!_.isUndefined(xid)) {
      url += "&xid=" + xid;
    }
    if (!_.isUndefined(x_name)) {
      url += "&x_name=" + encodeURIComponent(x_name);
    }
    if (!_.isUndefined(x_profile_image_url)) {
      url += "&x_profile_image_url=" + encodeURIComponent(x_profile_image_url);
    }
    if (!_.isUndefined(x_email)) {
      url += "&x_email=" + encodeURIComponent(x_email);
    }
    if (!_.isUndefined(parent_url)) {
      url += "&parent_url=" + encodeURIComponent(parent_url);
    }
    if (!_.isUndefined(dwok)) {
      url += "&dwok=" + dwok;
    }
    // Add referrer to URL params to pass it along
    if (!_.isUndefined(referrer)) {
      url += "&referrer=" + encodeURIComponent(referrer);
    }
    return url;
  }

  // also parse out the page_id after the '/', and look that up, along with site_id in the page_ids table
  pg.queryP_readOnly(
    "select * from page_ids where site_id = ($1) and page_id = ($2);",
    [site_id, page_id]
  )
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        // conv not initialized yet
        initializeImplicitConversation(site_id, page_id, o)
          .then(function (conv) {
            let url = _.isUndefined(demo)
              ? buildConversationUrl(req, conv.zinvite)
              : buildConversationDemoUrl(req, conv.zinvite);
            const modUrl = buildModerationUrl(req, conv.zinvite);
            const seedUrl = buildSeedUrl(req, conv.zinvite);
            if (conv.created)
              sendImplicitConversationCreatedEmails(
                site_id,
                page_id,
                url,
                modUrl,
                seedUrl
              )
                .then(function () {
                  logger.info("email sent");
                })
                .catch(function (err: any) {
                  logger.error("email fail", err);
                });

            url = appendParams(url);
            res.redirect(url);
          })
          .catch(function (err: any) {
            if (err instanceof MissingSiteOwnerError) {
              failJson(res, 404, "polis_err_bad_site_id", err);
              return;
            }
            failJson(res, 500, "polis_err_creating_conv", err);
          });
      } else {
        // conv was initialized, nothing to set up
        getZinvite(rows[0].zid)
          .then(function (conversation_id: any) {
            let url = buildConversationUrl(req, conversation_id);
            url = appendParams(url);
            res.redirect(url);
          })
          .catch(function (err: any) {
            failJson(res, 500, "polis_err_finding_conversation_id", err);
          });
      }
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_redirecting_to_conv", err);
    });
}

function sendImplicitConversationCreatedEmails(
  site_id: string,
  page_id: string,
  url: string,
  modUrl: string,
  seedUrl: string
) {
  const body =
    "" +
    "Conversation created!" +
    "\n" +
    "\n" +
    "You can find the conversation here:\n" +
    url +
    "\n" +
    "You can moderate the conversation here:\n" +
    modUrl +
    "\n" +
    "\n" +
    'We recommend you add 2-3 short statements to start things off. These statements should be easy to agree or disagree with. Here are some examples:\n "I think the proposal is good"\n "This topic matters a lot"\n or "The bike shed should have a metal roof"\n\n' +
    "You can add statements here:\n" +
    seedUrl +
    "\n" +
    "\n" +
    "Feel free to reply to this email if you have questions." +
    "\n" +
    "\n" +
    "Additional info: \n" +
    'site_id: "' +
    site_id +
    '"\n' +
    'page_id: "' +
    page_id +
    '"\n' +
    "\n";

  return pg
    .queryP("select email from users where site_id = ($1)", [site_id])
    .then(function (rows: any) {
      const emails = _.pluck(rows, "email");

      return sendMultipleTextEmails(
        Config.polisFromAddress,
        emails,
        "Polis conversation created",
        body
      );
    });
}

export { handle_GET_implicit_conversation_generation };
