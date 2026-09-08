import { getUserInfoForUid2 } from "../user";
import { doAddDataExportTask, isModerator } from "../utils/common";
import { getZinvite } from "../utils/zinvite";
import Config from "../config";
import { failJson } from "../utils/fail";
import AWS from "aws-sdk";
import { UserInfo } from "../d";

AWS.config.update({ region: Config.awsRegion });
const s3Client = new AWS.S3({ apiVersion: "2006-03-01" });

function handle_GET_dataExport(
  req: { p: { uid?: number; zid: number; unixTimestamp: number; format: any } },
  res: { json: (arg0: {}) => void }
) {
  getUserInfoForUid2(req.p.uid)
    .then((user: UserInfo) => {
      return doAddDataExportTask(
        Config.mathEnv,
        user.email!,
        req.p.zid,
        req.p.unixTimestamp * 1000,
        req.p.format,
        Math.abs((Math.random() * 999999999999) >> 0)
      )
        .then(() => {
          res.json({});
        })
        .catch((err: any) => {
          failJson(res, 500, "polis_err_data_export123", err);
        });
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_data_export123b", err);
    });
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

  // A signed URL hands out the conversation's full vote/comment dump, so it
  // requires ownership of the conversation the request resolved, exactly as
  // the report export routes do. `filename` is caller input and grants
  // nothing on its own.
  let isMod: boolean;
  try {
    isMod = await isModerator(zid, uid);
  } catch (err) {
    return failJson(res, 500, "polis_err_data_export_results_auth_check", err);
  }
  if (!isMod) {
    return failJson(res, 403, "polis_err_data_export_results_auth");
  }

  if (!filename || typeof filename !== "string") {
    return failJson(res, 400, "polis_err_data_export_results_filename_missing");
  }

  // Reject path separators, traversal and anything else that is not a bare
  // export name before it can reach the key.
  const parsed = EXPORT_FILENAME.exec(filename);
  if (!parsed) {
    return failJson(res, 400, "polis_err_data_export_results_filename_invalid");
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
}

export { handle_GET_dataExport, handle_GET_dataExport_results };
