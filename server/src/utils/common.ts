import _ from "underscore";
import { Client } from "pg";
import pg from "../db/pg-query";
import { getConversationInfo } from "../conversation";
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

const polisDevs = Config.adminUIDs ? JSON.parse(Config.adminUIDs) : [];

function isPolisDev(uid?: any) {
  return polisDevs.indexOf(uid) >= 0;
}

const polisTypes: PolisTypes = {
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
  zid: number,
  uid?: number,
  callback?: {
    (err: any): void;
    (err: any): void;
    (err: any): void;
    (err: any): void;
    (err: any): void;
    (arg0: any): void;
  }
) {
  pg.query_readOnly(
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

function isModerator(zid: number, uid?: number) {
  if (isPolisDev(uid)) {
    return Promise.resolve(true);
  }
  return pg
    .queryP_readOnly(
      "select count(*) from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($2))) and zid = ($1);",
      [zid, uid]
    )
    .then(function (rows: { count: number }[]) {
      return rows[0].count >= 1;
    });
}

function isOwner(zid: number, uid: number) {
  return getConversationInfo(zid).then(function (info: any) {
    return info.owner === uid;
  });
}

const escapeLiteral = Client.prototype.escapeLiteral;

function isDuplicateKey(err: {
  code: string | number;
  sqlState: string | number;
  messagePrimary: string | string[];
}) {
  const isdup =
    err.code === 23505 ||
    err.code === "23505" ||
    err.sqlState === 23505 ||
    err.sqlState === "23505" ||
    (err.messagePrimary && err.messagePrimary.includes("duplicate key value"));
  return isdup;
}

function ifDefinedSet(
  name: string,
  source: { [x: string]: any },
  dest: { [x: string]: any }
) {
  if (!_.isUndefined(source[name])) {
    dest[name] = source[name];
  }
}

function isUserAllowedToCreateConversations(
  uid?: any,
  callback?: {
    (err: any, isAllowed: any): void;
    (err: any, isAllowed: any): void;
    (arg0: null, arg1: boolean): void;
  }
) {
  callback?.(null, true);
}

function ifDefinedFirstElseSecond(first: any, second: boolean) {
  return _.isUndefined(first) ? second : first;
}

//todo: only one export

export {
  escapeLiteral,
  ifDefinedFirstElseSecond,
  ifDefinedSet,
  isConversationOwner,
  isDuplicateKey,
  isModerator,
  isOwner,
  isPolisDev,
  isUserAllowedToCreateConversations,
  polisTypes,
};

export default {
  escapeLiteral,
  isModerator,
  isOwner,
  polisTypes,
};
