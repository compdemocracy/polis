// Source text of the dependency-free validator generated into client-report
// (client-report/src/contract/validate.js). client-report is plain JavaScript
// with no JSON Schema library; this validator implements exactly the keyword
// subset the generated schemas use (generate.ts refuses any other keyword),
// and the server tests prove it agrees with ajv on every generated fixture and
// recorded body.
//
// CLIENT_VALIDATOR_CORE has no imports or exports, so the server tests can
// evaluate the same text the client ships.

export const CLIENT_VALIDATOR_CORE = String.raw`function contractTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function contractMatchesType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return contractTypeOf(value) === "object";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function contractEqual(a, b) {
  if (a === b) return true;
  const ta = contractTypeOf(a);
  if (ta !== contractTypeOf(b)) return false;
  if (ta === "array") {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!contractEqual(a[i], b[i])) return false;
    return true;
  }
  if (ta === "object") {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !contractEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function contractPointer(path, key) {
  return path + "/" + String(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

function contractCheck(schema, value, path, errors) {
  const at = path || "/";
  if (schema.anyOf) {
    let best = null;
    for (const branch of schema.anyOf) {
      const branchErrors = [];
      contractCheck(branch, value, path, branchErrors);
      if (branchErrors.length === 0) return;
      if (best === null || branchErrors.length < best.length) best = branchErrors;
    }
    errors.push(at + ": must match one of " + schema.anyOf.length + " alternatives");
    for (const e of best) errors.push(e);
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => contractMatchesType(value, t))) {
      errors.push(at + ": must be " + types.join(" or "));
      return;
    }
  }
  if (schema.const !== undefined && !contractEqual(schema.const, value)) {
    errors.push(at + ": must be " + JSON.stringify(schema.const));
  }
  if (schema.enum !== undefined && !schema.enum.some((v) => contractEqual(v, value))) {
    errors.push(at + ": must be one of " + JSON.stringify(schema.enum));
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) {
      errors.push(at + ": must have at least " + schema.minLength + " characters");
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(at + ": must match " + schema.pattern);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(at + ": must be >= " + schema.minimum);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(at + ": must be <= " + schema.maximum);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(at + ": must have at least " + schema.minItems + " items");
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(at + ": must have at most " + schema.maxItems + " items");
    }
    if (schema.uniqueItems) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (contractEqual(value[i], value[j])) {
            errors.push(at + ": items " + i + " and " + j + " must be unique");
          }
        }
      }
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => contractCheck(schema.items, item, contractPointer(path, i), errors));
    }
  }
  if (contractTypeOf(value) === "object") {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push(at + ": must have at least " + schema.minProperties + " properties");
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push(at + ": must have at most " + schema.maxProperties + " properties");
    }
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(at + ": must have property " + JSON.stringify(key));
      }
    }
    const properties = schema.properties || {};
    const patterns = Object.keys(schema.patternProperties || {});
    for (const key of keys) {
      const child = contractPointer(path, key);
      let matched = false;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        matched = true;
        contractCheck(properties[key], value[key], child, errors);
      }
      for (const pattern of patterns) {
        if (new RegExp(pattern).test(key)) {
          matched = true;
          contractCheck(schema.patternProperties[pattern], value[key], child, errors);
        }
      }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) {
          errors.push(at + ": must not have property " + JSON.stringify(key));
        } else if (schema.additionalProperties !== true) {
          contractCheck(schema.additionalProperties, value[key], child, errors);
        }
      }
    }
  }
}

function contractValidate(schema, value, subset) {
  const errors = [];
  const root = subset ? Object.assign({}, schema, { required: [] }) : schema;
  contractCheck(root, value, "", errors);
  return { valid: errors.length === 0, errors: errors };
}`;

export function clientReportValidatorSource(header: string): string {
  return `${header}
import delphiJobResultSchema from "./delphiJobResult.schema.json";
import pca2Schema from "./pca2.schema.json";

export const DELPHI_JOB_RESULT_CONTRACT_VERSION = delphiJobResultSchema.$id;
export const PCA2_CONTRACT_VERSION = pca2Schema.$id;

${CLIENT_VALIDATOR_CORE}

// Returns { valid, errors }; never throws. errors are "<JSON pointer>: <reason>".
export function validateDelphiJobResult(value) {
  return contractValidate(delphiJobResultSchema, value, false);
}

// A ?keys= response carries a subset of the pca2 properties: pass { subset: true }.
export function validatePca2(value, options) {
  return contractValidate(pca2Schema, value, Boolean(options && options.subset));
}
`;
}
