'use strict';
// JSON Schema subset used by the checked-in v1 schemas.
function validate(value, schema, root = schema, path = '$') {
  if (schema.$ref) return validate(value, root.$defs[schema.$ref.split('/').pop()], root, path);
  if(schema.pattern && typeof value==='string' && !new RegExp(schema.pattern).test(value))throw Error(`${path}: pattern mismatch`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !types.some((t) => t === kind || (t === 'integer' && Number.isInteger(value))))
    throw Error(`${path}: expected ${types.join('|')}`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const)
    throw Error(`${path}: invalid version/constant`);
  if (schema.enum && !schema.enum.includes(value)) throw Error(`${path}: invalid enum`);
  if (
    typeof value === 'number' &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw Error(`${path}: number out of range`);
  if (
    typeof value === 'string' &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  )
    throw Error(`${path}: string too short`);
  if (kind === 'object') {
    for (const k of schema.required || [])
      if (!Object.hasOwn(value, k)) throw Error(`${path}.${k}: missing field`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) validate(v, sub, root, `${path}.${k}`);
      else if (schema.additionalProperties === false) throw Error(`${path}.${k}: unknown field`);
      else if (typeof schema.additionalProperties === 'object')
        validate(v, schema.additionalProperties, root, `${path}.${k}`);
    }
  }
  if (kind === 'array') {
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length)
      throw Error(`${path}: duplicate item`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, root, `${path}[${i}]`));
  }
  return value;
}
module.exports = { validate };
