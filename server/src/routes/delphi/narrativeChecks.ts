/** Deterministic checks of an imported narrative against the data its prompts
 * showed the model (the prompt pack): no model is called and nothing here
 * refuses an import. Each section's results are stored with the job and shown
 * beside it; they measure grounding (does the text say what the data says,
 * where a test can tell), not prose quality.
 *
 * Every count comes from the pack, as Delphi's narrative step read it (agree
 * as agree, through Delphi's vote convention module); no vote is read from
 * storage here and no sign is converted. */

export const CHECKS_VERSION = "narrative-checks/1";

// The checks run on the request's own event loop, the one that also answers
// votes, comments and the next comment. The import's bounds (1 MiB, 250 KB a
// section, 4,000 characters a clause) admit about 100,000 quotations in one
// body, each compared with every comment it can lean on: unbounded, one import
// held the event loop for seconds. So each section checks at most this many
// quotations and stated shares; the rest are counted as unchecked and the
// section is not grounded. A narrative a model writes has a handful of each.
export const MAX_QUOTES_PER_SECTION = 200;
export const MAX_SHARES_PER_SECTION = 400;
// At most this many examples of each kind are kept with a section's checks.
export const MAX_EXAMPLES = 20;
// An import carries up to 99 sections, and a section may show thousands of
// comments, so the caps above still multiply. Across one import the checks
// therefore read at most this many characters of comment text looking for
// quotations, and compare at most this many comment shares with stated ones
// (each a few tens of milliseconds at most). A quotation or share past either
// is counted as unchecked, as past the caps above. The count is of work, not
// of time, so the same import always gets the same checks.
export const MAX_QUOTE_SEARCH_CHARS = 8_000_000;
export const MAX_SHARE_COMPARISONS = 8_000_000;

/** What one import may still spend on the checks; shared by its sections. */
export type CheckBudget = { quoteChars: number; shareComparisons: number };
export const checkBudget = (): CheckBudget => ({
  quoteChars: MAX_QUOTE_SEARCH_CHARS,
  shareComparisons: MAX_SHARE_COMPARISONS,
});

export type PackComment = {
  id: number;
  text: string;
  votes: number;
  agrees: number;
  disagrees: number;
  passes: number;
  groups: Record<string, { votes: number; agrees: number; disagrees: number; passes: number }>;
};
export type PackSection = { section: string; citation_ids: number[]; comments: PackComment[] };
export type Ratio = { passed: number; total: number };
export type SectionChecks = {
  clauses: number;
  clauses_cited: Ratio;
  citations_exist: Ratio & { unknown: number[] };
  citations_in_section: Ratio & { outside: number[] };
  quoted_text_found: Ratio & { not_found: string[]; unchecked: number };
  quoted_shares_match: Ratio & { unmatched: string[]; unchecked: number };
  rules: { percentages: number; comment_numbers: number; links_or_contacts: number };
  grounded: boolean;
};
export type JobChecks = {
  version: string;
  summary: {
    sections: number;
    grounded_sections: number;
    clauses: number;
    clauses_cited: Ratio;
    citations_exist: Ratio;
    citations_in_section: Ratio;
    quoted_text_found: Ratio;
    quoted_shares_match: Ratio;
  };
  sections: Record<string, SectionChecks>;
};

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Text inside straight or curly double quotes, three words or more: a quoted
// span is a claim that a participant wrote those words.
const QUOTE = /["“]([^"“”]{3,400})["”]/g;
// A share stated in the prose: "45%", "45 percent", "45 per cent".
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)/gi;
// "12 of 20" or "12 out of 20".
const FRACTION = /\b(\d{1,6})\s+(?:out\s+)?of\s+(?:the\s+)?(\d{1,6})\b/gi;
const COMMENT_NUMBER = /(?:#\s?\d+|\b(?:comment|statement)s?\s+(?:no\.?\s*|number\s+)?\d+)/gi;
// An e-mail address is found by the character before its "@" and its bounded
// domain, one match per address: matching the whole local part made a clause
// such as "a.a.a.…" a quadratic search.
const LINK_OR_CONTACT =
  /(?:https?:\/\/|www\.)\S+|[\w.+-]@[\w-]{1,253}\.[\w.]{1,253}\b|\+?\d[\d ()-]{8,}\d/gi;

function shares(c: PackComment): number[] {
  const out: number[] = [];
  // A share needs at least one voter; `total` is a count of voters, never a vote.
  const add = (n: { votes: number; agrees: number; disagrees: number; passes: number }) => {
    const total = n.votes;
    if (total >= 1)
      for (const k of [n.agrees, n.disagrees, n.passes]) out.push((100 * k) / total);
  };
  add(c);
  for (const g of Object.values(c.groups || {})) add(g);
  return out;
}

const count = (text: string, re: RegExp) => (text.match(re) || []).length;
// An example is stored as jsonb, which refuses NUL and an unpaired surrogate
// (cutting at 200 code units can split an emoji): each becomes U+FFFD.
const storable = (s: string) =>
  s.replace(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
const ratio = (passed: number, total: number): Ratio => ({ passed, total });
const all = (r: Ratio) => r.passed === r.total;

/** The checks of one section's document. `known` is every comment id the pack
 * shows the model in any section; `normalized` holds each comment's text as
 * the quotation check compares it, and `shareCache` each comment's shares,
 * both filled on first use; `budget` is what the import may still spend (pass
 * the same three for a whole import, so no comment is prepared twice and the
 * budget covers every section). */
export function checkSection(
  reportData: any,
  section: PackSection,
  known: Map<number, PackComment>,
  normalized: Map<number, string> = new Map(),
  budget: CheckBudget = checkBudget(),
  shareCache: Map<number, number[]> = new Map()
): SectionChecks {
  const allowed = new Set(section.citation_ids);
  let clauses = 0;
  let cited = 0;
  const citedIds = new Set<number>();
  const quotes: { text: string; found: boolean }[] = [];
  const stated: { text: string; matched: boolean }[] = [];
  let quotesUnchecked = 0;
  let sharesUnchecked = 0;
  const rules = { percentages: 0, comment_numbers: 0, links_or_contacts: 0 };
  const textOf = (c: PackComment) => {
    let text = normalized.get(c.id);
    if (text === undefined) {
      text = normalize(c.text);
      normalized.set(c.id, text);
    }
    return text;
  };
  const sharesOf = (c: PackComment) => {
    let out = shareCache.get(c.id);
    if (out === undefined) {
      out = shares(c);
      shareCache.set(c.id, out);
    }
    return out;
  };
  // Whether a comment of `basis` contains the quotation; null when the
  // import's budget ran out first (the quotation is then unchecked).
  const quoteFound = (quoted: string, basis: PackComment[]): boolean | null => {
    for (const c of basis) {
      // One more than the length, so an empty comment still costs a step.
      const cost = c.text.length + 1;
      if (budget.quoteChars < cost) return null;
      budget.quoteChars -= cost;
      if (textOf(c).includes(quoted)) return true;
    }
    return false;
  };
  // Whether a comment of `basis` has a share within one point; null as above.
  const shareNear = (value: number, basis: PackComment[]): boolean | null => {
    for (const c of basis) {
      const candidates = sharesOf(c);
      const cost = candidates.length + 1;
      if (budget.shareComparisons < cost) return null;
      budget.shareComparisons -= cost;
      // |s - value| <= 1 without a global lookup in the innermost loop: in a
      // vm context, as Jest runs the tests, each Math lookup costs far more.
      if (candidates.some((s) => s - value <= 1 && value - s <= 1)) return true;
    }
    return false;
  };
  const share = (text: string, matched: () => boolean | null) => {
    if (stated.length >= MAX_SHARES_PER_SECTION) {
      sharesUnchecked++;
      return;
    }
    const result = matched();
    if (result === null) sharesUnchecked++;
    else stated.push({ text, matched: result });
  };
  const resolve = (ids: number[]) =>
    ids.map((id) => known.get(id)).filter((c): c is PackComment => !!c);
  // Every comment the section shows, resolved once for the whole section.
  let sectionBasis: PackComment[] | undefined;
  for (const paragraph of reportData?.paragraphs || []) {
    for (const sentence of paragraph?.sentences || []) {
      for (const clause of sentence?.clauses || []) {
        const text: string = typeof clause?.text === "string" ? clause.text : "";
        const ids: number[] = Array.isArray(clause?.citations) ? clause.citations : [];
        clauses++;
        if (ids.length) cited++;
        ids.forEach((id) => citedIds.add(id));
        // The comments a claim in this clause can lean on: its own citations,
        // else every comment the section shows. Resolved only when a
        // quotation or a share in the clause is checked against them.
        let clauseBasis: PackComment[] | undefined;
        const basis = () =>
          ids.length
            ? (clauseBasis ??= resolve(ids))
            : (sectionBasis ??= resolve(section.citation_ids));
        for (const m of text.matchAll(QUOTE)) {
          const quoted = normalize(m[1]);
          if (quoted.split(" ").length < 3) continue;
          if (quotes.length >= MAX_QUOTES_PER_SECTION) {
            quotesUnchecked++;
            continue;
          }
          const found = quoteFound(quoted, basis());
          if (found === null) quotesUnchecked++;
          else quotes.push({ text: m[1], found });
        }
        for (const m of text.matchAll(PERCENT)) {
          rules.percentages++;
          share(m[0], () => shareNear(Number(m[1]), basis()));
        }
        for (const m of text.matchAll(FRACTION)) {
          const of = Number(m[2]);
          if (of > 0 && Number(m[1]) <= of)
            share(m[0], () => shareNear((100 * Number(m[1])) / of, basis()));
        }
        rules.comment_numbers += count(text, COMMENT_NUMBER);
        rules.links_or_contacts += count(text, LINK_OR_CONTACT);
      }
    }
  }
  const ids = [...citedIds].sort((a, b) => a - b);
  const unknown = ids.filter((id) => !known.has(id));
  const outside = ids.filter((id) => !allowed.has(id));
  const result: SectionChecks = {
    clauses,
    clauses_cited: ratio(cited, clauses),
    citations_exist: { ...ratio(ids.length - unknown.length, ids.length), unknown },
    citations_in_section: { ...ratio(ids.length - outside.length, ids.length), outside },
    quoted_text_found: {
      ...ratio(quotes.filter((q) => q.found).length, quotes.length),
      not_found: quotes
        .filter((q) => !q.found)
        .slice(0, MAX_EXAMPLES)
        .map((q) => storable(q.text.slice(0, 200))),
      unchecked: quotesUnchecked,
    },
    quoted_shares_match: {
      ...ratio(stated.filter((s) => s.matched).length, stated.length),
      unmatched: stated
        .filter((s) => !s.matched)
        .slice(0, MAX_EXAMPLES)
        .map((s) => storable(s.text)),
      unchecked: sharesUnchecked,
    },
    rules,
    grounded: false,
  };
  result.grounded =
    all(result.clauses_cited) &&
    all(result.citations_exist) &&
    all(result.citations_in_section) &&
    all(result.quoted_text_found) &&
    all(result.quoted_shares_match) &&
    quotesUnchecked === 0 &&
    sharesUnchecked === 0 &&
    rules.percentages === 0 &&
    rules.comment_numbers === 0 &&
    rules.links_or_contacts === 0;
  return result;
}

/** The checks of every imported section, and their totals. */
export function checkNarrative(
  results: { section: string; report_data: any }[],
  sections: PackSection[],
  everySection: PackSection[]
): JobChecks {
  const known = new Map<number, PackComment>();
  for (const s of everySection) for (const c of s.comments || []) known.set(c.id, c);
  const bySection = new Map(sections.map((s) => [s.section, s]));
  const normalized = new Map<number, string>();
  const shareCache = new Map<number, number[]>();
  const budget = checkBudget();
  const out: Record<string, SectionChecks> = {};
  for (const r of results) {
    const section = bySection.get(r.section);
    if (section)
      out[r.section] = checkSection(r.report_data, section, known, normalized, budget, shareCache);
  }
  const sum = (pick: (c: SectionChecks) => Ratio): Ratio =>
    Object.values(out).reduce(
      (a, c) => ({ passed: a.passed + pick(c).passed, total: a.total + pick(c).total }),
      { passed: 0, total: 0 }
    );
  return {
    version: CHECKS_VERSION,
    summary: {
      sections: Object.keys(out).length,
      grounded_sections: Object.values(out).filter((c) => c.grounded).length,
      clauses: Object.values(out).reduce((a, c) => a + c.clauses, 0),
      clauses_cited: sum((c) => c.clauses_cited),
      citations_exist: sum((c) => c.citations_exist),
      citations_in_section: sum((c) => c.citations_in_section),
      quoted_text_found: sum((c) => c.quoted_text_found),
      quoted_shares_match: sum((c) => c.quoted_shares_match),
    },
    sections: out,
  };
}
