import _ from "underscore";
import pg from "pg";
import dbPgQuery, {
  query as pgQuery,
  query_readOnly as pgQuery_readOnly,
  queryP as pgQueryP,
  queryP_metered_readOnly as pgQueryP_metered_readOnly,
  queryP_readOnly as pgQueryP_readOnly,
  queryP_readOnly_wRetryIfEmpty as pgQueryP_readOnly_wRetryIfEmpty,
} from "../db/pg-query";
import akismetLib from "akismet";
import logger from "../utils/logger";
import Conversation from "../conversation";
import Config from "../config";

type PolisTypes = {
  reactions: Reactions;
  staractions: StarActions;
  mod: Mod;
  reactionValues?: any;
  starValues?: any;
};

type Reactions = {
  push: number;
  pull: number;
  see: number;
  pass: number;
};

type StarActions = {
  unstar: number;
  star: number;
};

type Mod = {
  ban: number;
  unmoderated: number;
  ok: number;
};

const serverUrl = Config.getServerUrl();

const polisDevs = Config.adminUIDs ? JSON.parse(Config.adminUIDs) : [];

let akismet = akismetLib.client({
  blog: serverUrl,
  apiKey: Config.akismetAntispamApiKey,
});

akismet.verifyKey(function (err: any, verified: any) {
  if (verified) {
    logger.debug("Akismet: API key successfully verified.");
  } else {
    logger.debug("Akismet: Unable to verify API key.");
  }
});

function isSpam(o: {
  comment_content: any;
  comment_author: any;
  permalink: string;
  user_ip: any;
  user_agent: any;
  referrer: any;
}) {
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  // @ts-ignore
  return new MPromise(
    "isSpam",
    function (resolve: (arg0: any) => void, reject: (arg0: any) => void) {
      akismet.checkSpam(o, function (err: any, spam: any) {
        if (err) {
          reject(err);
        } else {
          resolve(spam);
        }
      });
    }
  );
}

function isPolisDev(uid?: any) {
  return polisDevs.indexOf(uid) >= 0;
}

function strToHex(str: string) {
  let hex, i;
  // let str = "\u6f22\u5b57"; // "\u6f22\u5b57" === "漢字"
  let result = "";
  for (i = 0; i < str.length; i++) {
    hex = str.charCodeAt(i).toString(16);
    result += ("000" + hex).slice(-4);
  }
  return result;
}

function hexToStr(hexString: string) {
  let j;
  let hexes = hexString.match(/.{1,4}/g) || [];
  let str = "";
  for (j = 0; j < hexes.length; j++) {
    str += String.fromCharCode(parseInt(hexes[j], 16));
  }
  return str;
}

let polisTypes: PolisTypes = {
  reactions: {
    push: 1,
    pull: -1,
    see: 0,
    pass: 0,
  },
  staractions: {
    unstar: 0,
    star: 1,
  },
  mod: {
    ban: -1,
    unmoderated: 0,
    ok: 1,
  },
};
polisTypes.reactionValues = _.values(polisTypes.reactions);
polisTypes.starValues = _.values(polisTypes.staractions);

function isConversationOwner(
  zid: any,
  uid?: any,
  callback?: {
    (err: any): void;
    (err: any): void;
    (err: any): void;
    (err: any, foo: any): void;
    (err: any, foo: any): void;
    (arg0: any): void;
  }
) {
  pgQuery_readOnly(
    "SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);",
    [zid, uid],
    function (err: number, docs: { rows: string | any[] }) {
      if (!docs || !docs.rows || docs.rows.length === 0) {
        err = err || 1;
      }
      callback?.(err);
    }
  );
}

function isModerator(zid: any, uid?: any) {
  if (isPolisDev(uid)) {
    return Promise.resolve(true);
  }
  return pgQueryP_readOnly(
    "select count(*) from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($2))) and zid = ($1);",
    [zid, uid]
    //     Argument of type '(rows: { count: number; }[]) => boolean' is not assignable to parameter of type '(value: unknown) => boolean | PromiseLike<boolean>'.
    // Types of parameters 'rows' and 'value' are incompatible.
    //     Type 'unknown' is not assignable to type '{ count: number; }[]'.ts(2345)
    // @ts-ignore
  ).then(function (rows: { count: number }[]) {
    return rows[0].count >= 1;
  });
}

function doAddDataExportTask(
  math_env: string | undefined,
  email: string,
  zid: number,
  atDate: number,
  format: string,
  task_bucket: number
) {
  return pgQueryP(
    "insert into worker_tasks (math_env, task_data, task_type, task_bucket) values ($1, $2, 'generate_export_data', $3);",
    [
      math_env,
      {
        email: email,
        zid: zid,
        "at-date": atDate,
        format: format,
      },
      task_bucket, // TODO hash the params to get a consistent number?
    ]
  );
}

function isOwner(zid: any, uid: string) {
  return Conversation.getConversationInfo(zid).then(function (info: any) {
    return info.owner === uid;
  });
}

const escapeLiteral = pg.Client.prototype.escapeLiteral;

function isDuplicateKey(err: {
  code: string | number;
  sqlState: string | number;
  messagePrimary: string | string[];
}) {
  let isdup =
    err.code === 23505 ||
    err.code === "23505" ||
    err.sqlState === 23505 ||
    err.sqlState === "23505" ||
    (err.messagePrimary && err.messagePrimary.includes("duplicate key value"));
  return isdup;
}

//todo: only one export

export {
  strToHex,
  hexToStr,
  polisTypes,
  isConversationOwner,
  isModerator,
  isPolisDev,
  isSpam,
  doAddDataExportTask,
  isOwner,
  escapeLiteral,
  isDuplicateKey,
};

export default {
  strToHex,
  hexToStr,
  polisTypes,
  isConversationOwner,
  isModerator,
  isPolisDev,
  isSpam,
  doAddDataExportTask,
  isOwner,
  escapeLiteral,
  isDuplicateKey,
};
