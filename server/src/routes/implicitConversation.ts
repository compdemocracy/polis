// NOTE: this isn't optimal
// rather than code for a new URL scheme for implicit conversations,
// the idea is to redirect implicitly created conversations
// to their zinvite based URL after creating the conversation.
// To improve conversation load time, this should be changed so that it
// does not redirect, and instead serves up the index.
// The routers on client and server will need to be updated for that

import _ from "underscore";
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

function registerPageId(site_id: string, page_id: string, zid: number) {
  return pg.queryP(
    "insert into page_ids (site_id, page_id, zid) values ($1, $2, $3);",
    [site_id, page_id, zid]
  );
}

function initializeImplicitConversation(
  site_id: string,
  page_id: string,
  o: {}
) {
  // find the user with that site_id.. wow, that will be a big index..
  // I suppose we could duplicate the site_ids that actually have conversations
  // into a separate table, and search that first, only searching users if nothing is there.
  return pg
    .queryP_readOnly(
      "select uid from users where site_id = ($1) and site_owner = TRUE;",
      [site_id]
    )
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        throw new Error("polis_err_bad_site_id");
      }
      return new Promise(function (
        resolve: (arg0: {
          owner: number;
          zid: number;
          zinvite: string;
        }) => void,
        reject: (arg0: string, arg1?: undefined) => void
      ) {
        const uid = rows[0].uid;
        //    create a conversation for the owner we got,
        const generateShortUrl = false;

        isUserAllowedToCreateConversations(
          uid,
          function (err: any, isAllowed: any) {
            if (err) {
              reject(err);
              return;
            }
            if (!isAllowed) {
              reject(err);
              return;
            }

            const params = Object.assign(o, {
              owner: uid,
              org_id: uid,
              // description: req.p.description,
              is_active: true,
              is_draft: false,
              is_public: true, // TODO remove this column
              is_anon: false,
              profanity_filter: true, // TODO this could be drawn from config for the owner
              spam_filter: true, // TODO this could be drawn from config for the owner
              strict_moderation: false, // TODO this could be drawn from config for the owner
              // context: req.p.context,
              owner_sees_participation_stats: false, // TODO think, and test join
            });

            const q = sql_conversations
              .insert(params)
              .returning("*")
              .toString();

            pg.query(
              q,
              [],
              function (err: any, result: { rows: { zid: number }[] }) {
                if (err) {
                  if (isDuplicateKey(err)) {
                    logger.error(
                      "polis_err_create_implicit_conv_duplicate_key",
                      err
                    );
                    reject("polis_err_create_implicit_conv_duplicate_key");
                  } else {
                    reject("polis_err_create_implicit_conv_db");
                  }
                }

                const zid =
                  result && result.rows && result.rows[0] && result.rows[0].zid;

                Promise.all([
                  registerPageId(site_id, page_id, zid),
                  generateAndRegisterZinvite(zid, generateShortUrl),
                ])
                  .then(function (o: any[]) {
                    // let notNeeded = o[0];
                    const zinvite = o[1];
                    // NOTE: OK to return conversation_id, because this conversation was just created by this user.
                    resolve({
                      owner: uid,
                      zid: zid,
                      zinvite: zinvite,
                    });
                  })
                  .catch(function (err: any) {
                    reject("polis_err_zinvite_create_implicit", err);
                  });
              }
            ); // end insert
          }
        ); // end isUserAllowedToCreateConversations

        //    add a record to page_ids
        //    (put the site_id in the smaller site_ids table)
        //    redirect to the zinvite url for the conversation
      });
    });
}

// as will checks like isParticipationView on the client.
function handle_GET_implicit_conversation_generation(
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
  if (!site_id_match?.length || (page_id_match && page_id_match?.length < 2)) {
    failJson(res, 404, "polis_err_parsing_site_id_or_page_id");
  }
  const site_id = site_id_match?.[0] as string;
  const page_id = page_id_match?.[1] as string;

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
  o.socialbtn_type = req.p.show_share ? 1 : 0;

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
          .then(function (conv: { zinvite: any }) {
            let url = _.isUndefined(demo)
              ? buildConversationUrl(req, conv.zinvite)
              : buildConversationDemoUrl(req, conv.zinvite);
            const modUrl = buildModerationUrl(req, conv.zinvite);
            const seedUrl = buildSeedUrl(req, conv.zinvite);
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
