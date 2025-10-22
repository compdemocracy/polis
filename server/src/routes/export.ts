// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import type { Response as ExpressResponse } from "express";
import { getZidForRid, getZidForUuid } from "../utils/zinvite";
import { failJson } from "../utils/fail";
import {
  sendVotesSummary,
  sendParticipantVotesSummary,
  sendParticipantImportance,
  sendCommentGroupsSummary,
  sendCommentClustersSummary,
  sendConversationSummary,
  sendParticipantXidsSummary,
  sendCommentSummary,
} from "../report";
import logger from "../utils/logger";

export async function handle_GET_reportExport(
  req: {
    p: { rid: string; report_type: string };
    headers: { host: string; "x-forwarded-proto": string };
  },
  res: ExpressResponse
) {
  const { rid, report_type } = req.p;
  try {
    const zid = await getZidForRid(rid);
    if (!zid) {
      failJson(res, 404, "polis_error_data_unknown_report");
      return;
    }

    switch (report_type) {
      case "summary.csv": {
        const siteUrl = `${req.headers["x-forwarded-proto"]}://${req.headers.host}`;
        await sendConversationSummary(zid, siteUrl, res);
        break;
      }

      case "comments.csv":
        await sendCommentSummary(zid, res);
        break;

      case "votes.csv":
        await sendVotesSummary(zid, res);
        break;

      case "participant-votes.csv":
        await sendParticipantVotesSummary(zid, res);
        break;

      case "participant-importance.csv":
        await sendParticipantImportance(zid, res);
        break;

      case "comment-groups.csv":
        await sendCommentGroupsSummary(zid, res);
        break;

      case "comment-clusters.csv":
        await sendCommentClustersSummary(zid, res);
        break;

      default:
        failJson(res, 404, "polis_error_data_unknown_report");
        break;
    }
  } catch (err) {
    const msg =
      err instanceof Error && err.message && err.message.startsWith("polis_")
        ? err.message
        : "polis_err_data_export";
    failJson(res, 500, msg, err);
  }
}

export async function handle_GET_xidReport(
  req: {
    p: { xid_report: string };
  },
  res: ExpressResponse
) {
  const { xid_report } = req.p;
  // example xid_report: "51295d48-9422-4a58-90dd-8a6e32cd1b52-xid.csv"
  try {
    const uuid = xid_report.split("-xid.csv")[0];
    const zid = await getZidForUuid(uuid);
    if (zid != null) {
      await sendParticipantXidsSummary(zid, res);
    } else {
      failJson(res, 404, "polis_error_data_unknown_report");
    }
  } catch (err) {
    logger.error("polis_err_report_xid", err);
    failJson(res, 500, "polis_err_data_export", err);
  }
}
