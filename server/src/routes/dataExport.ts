import { getUserInfoForUid2 } from "../user";
import { doAddDataExportTask, isModerator } from "../utils/common";
import { getZinvite } from "../utils/zinvite";
import Config from "../config";
import { failJson } from "../utils/fail";
import AWS from "aws-sdk";
import { UserInfo } from "../d";
import logger from "../utils/logger";
import {
  conversationExportSize,
  DATA_EXPORT_TOO_LARGE,
  dataExportStreamsLocally,
  writeConversationZip,
} from "../export/conversationZip";

AWS.config.update({ region: Config.awsRegion });
const s3Client = new AWS.S3({ apiVersion: "2006-03-01" });

/**
 * The export served by this server when there is no S3 bucket for a dump to
 * go to (or OFFLINE is set): the conversation's report export files, streamed
 * as one zip in this response. See src/export/conversationZip.ts.
 */
async function streamConversationExport(
  req: { headers?: Record<string, any> },
  res: any,
  zid: number
) {
  let size: Awaited<ReturnType<typeof conversationExportSize>>;
  let zinvite: string | undefined;
  try {
    size = await conversationExportSize(zid);
    zinvite = (await getZinvite(zid)) as string | undefined;
  } catch (err) {
    return failJson(res, 500, "polis_err_data_export_size", err);
  }
  if (size.cells > Config.dataExportMaxCells) {
    return failJson(res, 413, DATA_EXPORT_TOO_LARGE, undefined, {
      cells: size.cells,
      limit: Config.dataExportMaxCells,
    });
  }

  // Same site URL the report export puts in summary.csv.
  const headers = req.headers || {};
  const siteUrl = `${headers["x-forwarded-proto"]}://${headers.host}`;
  // The name the S3 worker gave its dumps: polis-export-<conversation_id>-<millis>.zip
  const name = `polis-export-${zinvite || zid}-${Date.now()}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  try {
    await writeConversationZip(res, zid, siteUrl);
  } catch (err) {
    if (res.destroyed) {
      // The client went away; the producers and their queries have stopped.
      logger.info("polis_data_export_client_closed", { zid });
      return;
    }
    if (!res.headersSent) {
      return failJson(res, 500, "polis_err_data_export_stream", err);
    }
    // Part of a zip is already out. Cut the connection so the client sees a
    // failed download, not a short archive that looks complete.
    logger.error("polis_err_data_export_stream", err);
    res.destroy?.();
  }
}

async function handle_GET_dataExport(
  req: {
    p: { uid?: number; zid: number; unixTimestamp: number; format: any };
    headers?: Record<string, any>;
  },
  res: any
) {
  const { uid, zid } = req.p;

  // Express 3 invokes route callbacks without awaiting them, so anything that
  // throws or rejects below — including the synchronous calls — would escape
  // the router and leave the request hanging as an unhandled rejection rather
  // than answering. Every path out of this handler writes a response.
  try {
    // Enqueuing an export is work performed against someone else's conversation:
    // it dumps that conversation's votes and comments to S3 under a filename the
    // requester chose (`unixTimestamp` becomes part of the object name) and mails
    // the download link to the *caller's* address. So it takes the same ownership
    // gate as GET /api/v3/dataExport/results, which serves the result.
    let isMod: boolean;
    try {
      isMod = await isModerator(zid, uid);
    } catch (err) {
      return failJson(res, 500, "polis_err_data_export_auth_check", err);
    }
    if (!isMod) {
      return failJson(res, 403, "polis_err_data_export_auth");
    }

    // No S3 bucket (or OFFLINE): nothing would ever produce or hold the dump,
    // so build the zip now and send it in this response.
    if (dataExportStreamsLocally()) {
      return await streamConversationExport(req, res, zid);
    }

    let user: UserInfo;
    try {
      user = await getUserInfoForUid2(uid);
    } catch (err) {
      return failJson(res, 500, "polis_err_data_export123b", err);
    }

    try {
      await doAddDataExportTask(
        Config.mathEnv,
        user.email!,
        zid,
        req.p.unixTimestamp * 1000,
        req.p.format,
        Math.abs((Math.random() * 999999999999) >> 0)
      );
    } catch (err) {
      return failJson(res, 500, "polis_err_data_export123", err);
    }

    res.json({});
  } catch (err) {
    return failJson(res, 500, "polis_err_data_export_misc", err);
  }
}

/**
 * The export worker (math/src/polismath/darwin/core.clj, `generate-filename`)
 * names every dump `polis-export-<conversation_id>-<epoch millis>.<zip|xlsx>`
 * and uploads it to `polis-datadump` under `<math env>/<that name>`.
 *
 * So the parts of a legitimate name are: the conversation the export belongs
 * to, a timestamp, and one of two extensions. Nothing else is ever a valid
 * export object, which is what makes it safe to rebuild the key from the
 * parsed pieces instead of concatenating whatever the caller sent.
 */
const EXPORT_FILENAME = /^polis-export-([A-Za-z0-9]+)-(\d{1,20})\.(zip|xlsx)$/;

async function handle_GET_dataExport_results(
  req: {
    p: {
      uid?: number;
      zid: number;
      conversation_id: string;
      filename?: string;
    };
  },
  res: { redirect: (arg0: any) => void }
) {
  const { uid, zid, filename } = req.p;

  // Same Express 3 error boundary as handle_GET_dataExport above: a rejection
  // or a throw from the signer must become a response, not a hung request.
  try {
    // A signed URL hands out the conversation's full vote/comment dump, so it
    // requires ownership of the conversation the request resolved, exactly as
    // the report export routes do. `filename` is caller input and grants
    // nothing on its own.
    let isMod: boolean;
    try {
      isMod = await isModerator(zid, uid);
    } catch (err) {
      return failJson(
        res,
        500,
        "polis_err_data_export_results_auth_check",
        err
      );
    }
    if (!isMod) {
      return failJson(res, 403, "polis_err_data_export_results_auth");
    }

    // The zip is streamed by GET /api/v3/dataExport itself here; no dump is
    // stored, and a signed URL would point at a bucket that is not there.
    if (dataExportStreamsLocally()) {
      return failJson(res, 404, "polis_err_data_export_results_not_stored");
    }

    if (!filename || typeof filename !== "string") {
      return failJson(
        res,
        400,
        "polis_err_data_export_results_filename_missing"
      );
    }

    // Reject path separators, traversal and anything else that is not a bare
    // export name before it can reach the key.
    const parsed = EXPORT_FILENAME.exec(filename);
    if (!parsed) {
      return failJson(
        res,
        400,
        "polis_err_data_export_results_filename_invalid"
      );
    }
    const [, namedConversationId, timestamp, extension] = parsed;

    // Bind the object to the conversation the caller was authorized for: the
    // conversation_id in the name has to be this conversation's, resolved from
    // the zid server-side rather than taken from the request.
    let zinvite: string | undefined;
    try {
      zinvite = (await getZinvite(zid)) as string | undefined;
    } catch (err) {
      return failJson(res, 500, "polis_err_data_export_results_zinvite", err);
    }
    if (!zinvite || zinvite !== namedConversationId) {
      return failJson(res, 403, "polis_err_data_export_results_conversation");
    }

    // Built from validated parts only; `filename` itself never reaches the key.
    const key = `${Config.mathEnv}/polis-export-${zinvite}-${timestamp}.${extension}`;

    const url = s3Client.getSignedUrl("getObject", {
      Bucket: "polis-datadump",
      Key: key,
      Expires: 60 * 60 * 24 * 7,
    });
    res.redirect(url);
  } catch (err) {
    return failJson(res, 500, "polis_err_data_export_results_misc", err);
  }
}

export { handle_GET_dataExport, handle_GET_dataExport_results };
