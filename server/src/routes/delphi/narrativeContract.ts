// The contract for Delphi results written outside the server: a canonical
// digest, a deliberately small schema validator and the error shape. The
// schema is the Delphi narrative document (paragraphs, sentences, cited
// clauses); collectiveExchange.ts narrows it to one cited statement per topic.
// Error codes are wire contract: the CLI recognises INVALID_NARRATIVE,
// IMPORT_CONFLICT, AUTH_REQUIRED and OWNER_REQUIRED by name.
import { createHash } from "crypto";
import schema from "./narrativeResultSchema";
export const resultSchema = schema;

export class NarrativeError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export function reject(message: string): never {
  throw new NarrativeError(400, "INVALID_NARRATIVE", message);
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: any): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
// Deliberately restricted to the keywords in our versioned schema. Unknown
// keywords are not accepted as implicit validation. No coercion or defaults.
export function validate(value: any, schema: any, path = "result"): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    !types.includes(type) &&
    !(types.includes("integer") && Number.isSafeInteger(value))
  )
    reject(`${path}: invalid type`);
  if (schema.enum && !schema.enum.includes(value))
    reject(`${path}: invalid value`);
  if (type === "object") {
    const keys = Object.keys(value);
    if (
      schema.required.some((k: string) => !Object.hasOwn(value, k)) ||
      keys.some((k) => !Object.hasOwn(schema.properties, k))
    )
      reject(`${path}: missing or unknown field`);
    keys.forEach((k) =>
      validate(value[k], schema.properties[k], `${path}.${k}`)
    );
  } else if (type === "array") {
    if (value.length < schema.minItems || value.length > schema.maxItems)
      reject(`${path}: invalid length`);
    value.forEach((v: any) => validate(v, schema.items, path));
  } else if (type === "string") {
    if (
      value.length < (schema.minLength || 0) ||
      value.length > schema.maxLength ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      reject(`${path}: invalid text`);
  } else if (type === "number") {
    if (
      !Number.isSafeInteger(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      reject(`${path}: invalid integer`);
  }
}
export function validateImport(value: any): void {
  if (value === undefined) reject("Import body is required");
  // Validate the bounded schema depth before stringifying hostile nested data.
  validate(value, resultSchema);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
    reject("Import exceeds 1 MiB");
}
export function validateResults(body: any, sections: any[]): void {
  const expected = new Map(sections.map((s) => [s.section, s]));
  const seen = new Set();
  if (body.results.length !== expected.size)
    reject("Results must cover exactly the exported sections");
  for (const result of body.results) {
    const section: any = expected.get(result.section);
    if (!section || seen.has(result.section))
      reject("Unknown or duplicate section");
    seen.add(result.section);
    const citations = new Set(section.citation_ids);
    for (const paragraph of result.report_data.paragraphs) {
      for (const sentence of paragraph.sentences) {
        for (const clause of sentence.clauses) {
          if (clause.citations.some((id: number) => !citations.has(id)))
            reject("Citation is not in the exported section");
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 250000)
      reject("Section exceeds storage limit");
  }
}
