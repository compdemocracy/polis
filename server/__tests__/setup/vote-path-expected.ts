/**
 * The vote-path recordings' expected-differences mechanism, as plain functions
 * so the mechanism itself is unit-tested (__tests__/unit/votePathExpected.test.ts)
 * and the recordings suite (__tests__/integration/vote-path-recordings.test.ts)
 * uses exactly the same code.
 *
 * An entry names ONE recorded case and spells out the change literally:
 *
 *   { "case": "<recorded case name>",
 *     "find": "<the changed text, exactly as in edge's golden>",
 *     "replace": "<the new text>",
 *     "status"?: <new status>, "contentType"?: "<new content type>",
 *     "whole_response"?: true, "whole_response_reason"?: "<why>",
 *     "why": "<the change>",
 *     "ruling": "pending" | "ruled:<who, when, where>" }
 *
 * Rules (each violation is a named problem; any problem fails the suite):
 *  - one entry per case, and the case must exist in the golden;
 *  - `find` is non-empty and occurs in that case's golden text exactly once;
 *  - `find` and `replace` carry at most MAX_CONTEXT characters of unchanged
 *    text around the change (just enough to make `find` unique);
 *  - an entry whose `find` covers WHOLE_SHARE or more of the response is a
 *    whole-response entry: `find` must then be the whole text and the entry
 *    must say `whole_response: true` with a reason;
 *  - `why` is non-empty and `ruling` is `pending` or `ruled:<reference>`.
 *    A pending entry passes the suite but not a merge: CI's vote-path golden
 *    guard fails a pull request to edge while any entry is pending.
 */
export type Observation = {
  status: number;
  contentType: string | null;
  text: string;
};

export type ExpectedDifference = {
  case: string;
  find: string;
  replace: string;
  status?: number;
  contentType?: string | null;
  whole_response?: boolean;
  whole_response_reason?: string;
  why: string;
  ruling: string;
};

export const RULING = /^(pending|ruled:\S.*)$/;
export const MAX_CONTEXT = 120;
export const WHOLE_SHARE = 0.9;

/** Characters `find` and `replace` share at their start plus at their end. */
export function sharedContext(find: string, replace: string): number {
  let prefix = 0;
  const max = Math.min(find.length, replace.length);
  while (prefix < max && find[prefix] === replace[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    find[find.length - 1 - suffix] === replace[replace.length - 1 - suffix]
  )
    suffix++;
  return prefix + suffix;
}

export function applyExpectedDifferences(
  golden: Record<string, Observation>,
  entries: ExpectedDifference[]
): { expected: Record<string, Observation>; problems: string[] } {
  const expected: Record<string, Observation> = {};
  for (const [name, obs] of Object.entries(golden)) expected[name] = { ...obs };
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of entries) {
    const name = d.case;
    if (seen.has(name)) {
      problems.push(`${name}: more than one entry`);
      continue;
    }
    seen.add(name);
    const target = expected[name];
    if (!target) {
      problems.push(`${name}: names no recorded case`);
      continue;
    }
    if (!d.why) problems.push(`${name}: why is empty`);
    if (typeof d.ruling !== "string" || !RULING.test(d.ruling))
      problems.push(`${name}: ruling must be "pending" or "ruled:<reference>"`);
    const hits = d.find ? target.text.split(d.find).length - 1 : 0;
    if (hits !== 1) {
      problems.push(`${name}: find occurs ${hits} times in the golden`);
      continue;
    }
    const whole =
      target.text.length > 0 &&
      d.find.length >= WHOLE_SHARE * target.text.length;
    if (whole || d.whole_response) {
      if (d.find !== target.text)
        problems.push(
          `${name}: a whole-response entry must find the whole text`
        );
      if (d.whole_response !== true || !d.whole_response_reason)
        problems.push(
          `${name}: replaces the whole response; needs whole_response: true and a reason`
        );
    } else {
      const context = sharedContext(d.find, d.replace);
      if (context > MAX_CONTEXT)
        problems.push(
          `${name}: carries ${context} unchanged characters; trim find/replace to the change`
        );
    }
    target.text = target.text.replace(d.find, () => d.replace);
    if (d.status !== undefined) target.status = d.status;
    if (d.contentType !== undefined) target.contentType = d.contentType;
  }
  return { expected, problems };
}

/** Recorded cases whose observation differs from what is expected. */
export function differingCases(
  observed: Map<string, Observation> | Record<string, Observation>,
  expected: Record<string, Observation>
): string[] {
  const get = (name: string) =>
    observed instanceof Map ? observed.get(name) : observed[name];
  return Object.keys(expected).filter(
    (name) => JSON.stringify(get(name)) !== JSON.stringify(expected[name])
  );
}

/** Entries still waiting for a ruling. */
export function pendingEntries(entries: ExpectedDifference[]): string[] {
  return entries.filter((d) => d.ruling === "pending").map((d) => d.case);
}
