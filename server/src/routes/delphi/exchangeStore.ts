import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { decodeItem, postgresResults } from "../../utils/delphiResults";
import {
  publishPostgresResultsAtomically,
  ResultPut,
} from "../../utils/delphiResultWriter";
import { NarrativeError } from "./narrativeContract";

/** Storage for collective statements imported from an outside agent.
 *
 * DELPHI_RESULT_BACKEND selects the store, as for every other Delphi result:
 * - dynamodb: one conditional TransactWrite.
 * - postgres: one primary transaction of pd_result_mutate puts, so imports are
 *   published into the conversation's served results and the existing
 *   statement readers see them. No fallback between the two. */
export const RECEIPT_TABLE = "Delphi_NarrativeReports";
export const IMPORT_ACTOR = "external-result-import";

type Sender = { send: (command: any) => Promise<any> };
export type ImportPut = ResultPut & { keyAttribute: string };

/** The private actor receipt. It has no report_id, so the report index never
 * returns it. The Postgres writer derives the conversation from the report ID
 * at the start of a Delphi_NarrativeReports key, so that key leads with it. */
export function receiptKey(ids: {
  reportId: string;
  zid: number;
  exportId: string;
}): string {
  return postgresResults()
    ? `${ids.reportId}#external-import#${ids.zid}#${ids.exportId}`
    : `external-import#${ids.zid}#${ids.exportId}`;
}

export async function readReceipt(reader: Sender, key: string): Promise<any> {
  const result = await reader.send(
    new GetCommand({
      TableName: RECEIPT_TABLE,
      Key: { rid_section_model: key, timestamp: "receipt" },
      ConsistentRead: true,
    })
  );
  return result.Item;
}

/** Write the receipt and every result together, each only if its key is new.
 * Returns "deduplicated" when an identical import (same result digest) was
 * already published; a different stored result is an IMPORT_CONFLICT. */
export async function publishImport(
  doc: Sender,
  receipt: { key: string; resultDigest: string; uid: number },
  puts: ImportPut[],
  conflictMessage: string
): Promise<"written" | "deduplicated"> {
  const receiptItem = {
    rid_section_model: receipt.key,
    timestamp: "receipt",
    metadata: { result_digest: receipt.resultDigest, imported_by: receipt.uid },
  };
  const all: ImportPut[] = [
    {
      TableName: RECEIPT_TABLE,
      keyAttribute: "rid_section_model",
      Item: receiptItem,
    },
    ...puts,
  ];
  if (!postgresResults()) {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: all.map((put) => ({
          Put: {
            TableName: put.TableName,
            ConditionExpression: `attribute_not_exists(${put.keyAttribute})`,
            Item: put.Item,
          },
        })),
      })
    );
    return "written";
  }
  const published = await publishPostgresResultsAtomically(
    all.map(({ TableName, Item }) => ({ TableName, Item })),
    IMPORT_ACTOR
  );
  if (published.outcome === "published") return "written";
  if (
    published.index === 0 &&
    decodeItem(published.previous).metadata?.result_digest ===
      receipt.resultDigest
  )
    return "deduplicated";
  throw new NarrativeError(409, "IMPORT_CONFLICT", conflictMessage);
}
