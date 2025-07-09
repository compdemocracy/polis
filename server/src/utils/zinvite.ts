// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import LruCache from "lru-cache";
import _ from "underscore";
import pg from "../db/pg-query";
import { MPromise } from "./metered";
import logger from "./logger";
const zidToConversationIdCache = new LruCache({
  max: 1000,
});

export function getZinvite(zid: number, dontUseCache?: boolean) {
  const cachedConversationId = zidToConversationIdCache.get(zid);
  if (!dontUseCache && cachedConversationId) {
    return Promise.resolve(cachedConversationId);
  }
  return pg
    .queryP_metered("getZinvite", "select * from zinvites where zid = ($1);", [
      zid,
    ])
    .then(function (rows: { zinvite: string }[]) {
      const conversation_id = (rows && rows[0] && rows[0].zinvite) || void 0;
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
  zids = _.map(zids, function (zid: number) {
    return Number(zid); // just in case
  });
  zids = _.uniq(zids);

  const uncachedZids = zids.filter(function (zid: number) {
    return !zidToConversationIdCache.get(zid);
  });
  const zidsWithCachedConversationIds = zids
    .filter(function (zid: number) {
      return !!zidToConversationIdCache.get(zid);
    })
    .map(function (zid: number) {
      return {
        zid: zid,
        zinvite: zidToConversationIdCache.get(zid),
      };
    });

  function makeZidToConversationIdMap(arrays: any[]) {
    const zid2conversation_id = {};
    arrays.forEach(function (a: any[]) {
      a.forEach(function (o: { zid: string | number; zinvite: any }) {
        zid2conversation_id[o.zid] = o.zinvite;
      });
    });
    return zid2conversation_id;
  }

  return MPromise(
    "getZinvites",
    function (resolve: (arg0: {}) => void, reject: (arg0: any) => void) {
      if (uncachedZids.length === 0) {
        resolve(makeZidToConversationIdMap([zidsWithCachedConversationIds]));
        return;
      }
      pg.query_readOnly(
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
  return pg
    .queryP("select zid from reports where rid = ($1);", [rid])
    .then((row: string | any[]) => {
      if (!row || !row.length) {
        return null;
      }
      return row[0].zid;
    });
}

export async function getZidForUuid(uuid: string): Promise<number | null> {
  try {
    const queryResult = await pg.queryP_readOnly(
      "SELECT zid FROM zinvites WHERE uuid = $1",
      [uuid]
    );

    const rows = queryResult as { zid: number }[];

    // Return zid if found, null otherwise
    return rows.length > 0 ? rows[0].zid : null;
  } catch (err) {
    logger.error(`Error finding zid for uuid ${uuid}: ${err}`);
    return null;
  }
}
