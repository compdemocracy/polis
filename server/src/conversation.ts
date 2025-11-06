import LruCache from "lru-cache";

import { ConversationInfo } from "./d";
import { DEFAULTS } from "./utils/constants";
import { fetchIndex, makeFileFetcher } from "./utils/file-fetcher";
import { ifDefinedFirstElseSecond } from "./utils/common";
import Config from "./config";
import logger from "./utils/logger";
import pg from "./db/pg-query";

function getConversationInfo(zid: number): Promise<ConversationInfo> {
  return new Promise((resolve, reject) => {
    pg.query(
      "SELECT * FROM conversations WHERE zid = ($1);",
      [zid],
      function (err: any, result: { rows: ConversationInfo[] }) {
        if (err) {
          reject(err);
        } else {
          resolve(result.rows[0]);
        }
      }
    );
  });
}

function getConversationInfoByConversationId(
  conversation_id: string
): Promise<ConversationInfo> {
  return new Promise((resolve, reject) => {
    pg.query(
      "SELECT * FROM conversations WHERE zid = (select zid from zinvites where zinvite = ($1));",
      [conversation_id],
      function (err: any, result: { rows: ConversationInfo[] }) {
        if (err) {
          reject(err);
        } else {
          resolve(result.rows[0]);
        }
      }
    );
  });
}

const conversationIdToZidCache = new LruCache<string, number>({
  max: 1000,
});

// NOTE: currently conversation_id is stored as zinvite
function getZidFromConversationId(conversation_id: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const cachedZid = conversationIdToZidCache.get(conversation_id);
    if (cachedZid !== undefined) {
      resolve(cachedZid);
      return;
    }

    pg.query_readOnly(
      "select zid from zinvites where zinvite = ($1);",
      [conversation_id],
      function (err: any, results: { rows: Array<{ zid: number }> }) {
        if (err) {
          return reject(err);
        }

        if (!results?.rows?.length) {
          logger.error(
            "polis_err_fetching_zid_for_conversation_id " + conversation_id,
            err
          );
          return reject("polis_err_fetching_zid_for_conversation_id");
        }

        const zid = results.rows[0].zid;
        conversationIdToZidCache.set(conversation_id, zid);
        return resolve(zid);
      }
    );
  });
}

const fetch404Page = makeFileFetcher(
  Config.staticFilesHost,
  Config.staticFilesAdminPort,
  "/404.html",
  {
    "Content-Type": "text/html",
  }
);

function doGetConversationPreloadInfo(conversation_id: any) {
  // return Promise.resolve({});
  return getZidFromConversationId(conversation_id)
    .then(function (zid: number) {
      return Promise.all([getConversationInfo(zid)]);
    })
    .then(function (a: any[]) {
      let conv = a[0];

      const auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(
        conv.auth_opt_allow_3rdparty,
        DEFAULTS.auth_opt_allow_3rdparty
      );

      conv = {
        topic: conv.topic,
        description: conv.description,
        created: conv.created,
        link_url: conv.link_url,
        parent_url: conv.parent_url,
        vis_type: conv.vis_type,
        write_type: conv.write_type,
        importance_enabled: conv.importance_enabled,
        help_type: conv.help_type,
        bgcolor: conv.bgcolor,
        help_color: conv.help_color,
        help_bgcolor: conv.help_bgcolor,
        style_btn: conv.style_btn,
        auth_needed_to_vote: false,
        auth_needed_to_write: false,
        auth_opt_allow_3rdparty: auth_opt_allow_3rdparty,
      };
      conv.conversation_id = conversation_id;
      // conv = Object.assign({}, optionalResults, conv);
      return conv;
    });
}

function fetchIndexForConversation(
  req: {
    path: string;
    headers?: { [x: string]: string; origin?: string; host: string };
    pipe: (arg0: any) => void;
  },
  res: any
) {
  const match = req.path.match(/[0-9][0-9A-Za-z]+/);
  let conversation_id: any;
  if (match && match.length) {
    conversation_id = match[0];
  }

  doGetConversationPreloadInfo(conversation_id)
    .then(function (x: any) {
      const preloadData = {
        conversation: x,
        // Nothing user-specific can go here, since we want to cache these
        // per-conv index files on the CDN.
      };
      fetchIndex(req, res, preloadData, Config.staticFilesParticipationPort);
    })
    .catch(function (err: any) {
      logger.error("polis_err_fetching_conversation_info", err);
      // @ts-ignore - Legacy Express v3 request type mismatch
      fetch404Page(req, res);
    });
}

export {
  doGetConversationPreloadInfo,
  fetchIndexForConversation,
  getConversationInfo,
  getConversationInfoByConversationId,
  getZidFromConversationId,
};
