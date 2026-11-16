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
  quoted_text_found: Ratio & { not_found: string[] };
  quoted_shares_match: Ratio & { unmatched: string[] };
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
const LINK_OR_CONTACT =
  /(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\+?\d[\d ()-]{8,}\d/gi;

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
const ratio = (passed: number, total: number): Ratio => ({ passed, total });
const all = (r: Ratio) => r.passed === r.total;

/** The checks of one section's document. `known` is every comment id the pack
 * shows the model in any section. */
export function checkSection(
  reportData: any,
  section: PackSection,
  known: Map<number, PackComment>
): SectionChecks {
  const allowed = new Set(section.citation_ids);
  let clauses = 0;
  let cited = 0;
  const citedIds = new Set<number>();
  const quotes: { text: string; found: boolean }[] = [];
  const stated: { text: string; matched: boolean }[] = [];
  const rules = { percentages: 0, comment_numbers: 0, links_or_contacts: 0 };
  for (const paragraph of reportData?.paragraphs || []) {
    for (const sentence of paragraph?.sentences || []) {
      for (const clause of sentence?.clauses || []) {
        const text: string = typeof clause?.text === "string" ? clause.text : "";
        const ids: number[] = Array.isArray(clause?.citations) ? clause.citations : [];
        clauses++;
        if (ids.length) cited++;
        ids.forEach((id) => citedIds.add(id));
        // The comments a claim in this clause can lean on: its own citations,
        // else every comment the section shows.
        const basis = (ids.length ? ids : section.citation_ids)
          .map((id) => known.get(id))
          .filter((c): c is PackComment => !!c);
        for (const m of text.matchAll(QUOTE)) {
          const quoted = normalize(m[1]);
          if (quoted.split(" ").length < 3) continue;
          quotes.push({
            text: m[1],
            found: basis.some((c) => normalize(c.text).includes(quoted)),
          });
        }
        const candidates = basis.flatMap(shares);
        const near = (value: number) => candidates.some((s) => Math.abs(s - value) <= 1);
        for (const m of text.matchAll(PERCENT)) {
          rules.percentages++;
          stated.push({ text: m[0], matched: near(Number(m[1])) });
        }
        for (const m of text.matchAll(FRACTION)) {
          const of = Number(m[2]);
          if (of > 0 && Number(m[1]) <= of)
            stated.push({ text: m[0], matched: near((100 * Number(m[1])) / of) });
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
      not_found: quotes.filter((q) => !q.found).map((q) => q.text.slice(0, 200)),
    },
    quoted_shares_match: {
      ...ratio(stated.filter((s) => s.matched).length, stated.length),
      unmatched: stated.filter((s) => !s.matched).map((s) => s.text),
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
  const out: Record<string, SectionChecks> = {};
  for (const r of results) {
    const section = bySection.get(r.section);
    if (section) out[r.section] = checkSection(r.report_data, section, known);
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
