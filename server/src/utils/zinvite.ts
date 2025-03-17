// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import LruCache from "lru-cache";
import _ from "underscore";
import {
  queryP as pgQueryP,
  query_readOnly as pgQuery_readOnly,
  queryP_metered as pgQueryP_metered,
  queryP_readOnly as pgQueryP_readOnly,
} from "../db/pg-query";
import { MPromise } from "./metered";
import logger from "./logger";
let zidToConversationIdCache = new LruCache({
  max: 1000,
});

export function getZinvite(zid: any, dontUseCache?: boolean) {
  let cachedConversationId = zidToConversationIdCache.get(zid);
  if (!dontUseCache && cachedConversationId) {
    return Promise.resolve(cachedConversationId);
  }
  return pgQueryP_metered(
    "getZinvite",
    "select * from zinvites where zid = ($1);",
    [zid]
  ).then(function (rows: { zinvite: any }[]) {
    let conversation_id = (rows && rows[0] && rows[0].zinvite) || void 0;
    if (conversation_id) {
      zidToConversationIdCache.set(zid, conversation_id);
    }
    return conversation_id;
  });
}

export function getZinvites(zids: any[]) {
  if (!zids.length) {
    return Promise.resolve(zids);
  }
  zids = _.map(zids, function (zid: any) {
    return Number(zid); // just in case
  });
  zids = _.uniq(zids);

  let uncachedZids = zids.filter(function (zid: any) {
    return !zidToConversationIdCache.get(zid);
  });
  let zidsWithCachedConversationIds = zids
    .filter(function (zid: any) {
      return !!zidToConversationIdCache.get(zid);
    })
    .map(function (zid: any) {
      return {
        zid: zid,
        zinvite: zidToConversationIdCache.get(zid),
      };
    });

  function makeZidToConversationIdMap(arrays: any[]) {
    let zid2conversation_id = {};
    arrays.forEach(function (a: any[]) {
      a.forEach(function (o: { zid: string | number; zinvite: any }) {
        // (property) zid: string | number
        // Element implicitly has an 'any' type because expression of type 'string | number' can't be used to index type '{}'.
        //           No index signature with a parameter of type 'string' was found onpe '{}'.ts(7053)
        // @ts-ignore
        zid2conversation_id[o.zid] = o.zinvite;
      });
    });
    return zid2conversation_id;
  }

  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  // @ts-ignore
  return new MPromise(
    "getZinvites",
    function (resolve: (arg0: {}) => void, reject: (arg0: any) => void) {
      if (uncachedZids.length === 0) {
        resolve(makeZidToConversationIdMap([zidsWithCachedConversationIds]));
        return;
      }
      pgQuery_readOnly(
        "select * from zinvites where zid in (" + uncachedZids.join(",") + ");",
        [],
        function (err: any, result: { rows: any }) {
          if (err) {
            reject(err);
          } else {
            resolve(
              makeZidToConversationIdMap([
                result.rows,
                zidsWithCachedConversationIds,
              ])
            );
          }
        }
      );
    }
  );
}

export function getZidForRid(rid: any) {
  return pgQueryP("select zid from reports where rid = ($1);", [rid]).then(
    //     Argument of type '(row: string | any[]) => any' is not assignable to parameter of type '(value: unknown) => any'.
    // Types of parameters 'row' and 'value' are incompatible.
    //   Type 'unknown' is not assignable to type 'string | any[]'.
    //     Type 'unknown' is not assignable to type 'any[]'.ts(2345)
    // @ts-ignore
    (row: string | any[]) => {
      if (!row || !row.length) {
        return null;
      }
      return row[0].zid;
    }
  );
}

export async function getZidForUuid(uuid: string): Promise<number | null> {
  logger.debug(`getZidForUuid: ${uuid}`);
  try {
    const queryResult = await pgQueryP_readOnly(
      "SELECT zid FROM zinvites WHERE uuid = $1", 
      [uuid]
    );
    
    const rows = queryResult as { zid: number }[];

    logger.debug(`queryResult: ${JSON.stringify(queryResult)}`);
    logger.debug(`rows: ${JSON.stringify(rows)}`);
    
    // Return zid if found, null otherwise
    return rows.length > 0 ? rows[0].zid : null;
  } catch (err) {
    logger.error(`Error finding zid for uuid ${uuid}: ${err}`);
    return null;
  }
}
