/**
 * A JSON Schema validator for the keywords samesight's published schemas use, and no
 * others: `unsupported` lists any a schema uses beyond them, so a schema test fails before
 * this validator would silently pass a document it cannot check. For tests only; not built
 * or published.
 */

export type Schema = { [k: string]: unknown };

const KEYWORDS = new Set(["$schema", "title", "description", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "$ref", "$defs", "minimum", "maximum"]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const is = (type: string, v: unknown) =>
  type === "object" ? isObject(v) : type === "array" ? Array.isArray(v) : type === "integer" ? Number.isInteger(v) : type === "null" ? v === null : typeof v === type;

/** Every subschema, with where it is. */
function* subschemas(s: Schema, at = "#"): Generator<[string, Schema]> {
  yield [at, s];
  for (const [k, v] of Object.entries((s.properties ?? {}) as Schema)) yield* subschemas(v as Schema, `${at}/properties/${k}`);
  for (const [k, v] of Object.entries((s.$defs ?? {}) as Schema)) yield* subschemas(v as Schema, `${at}/$defs/${k}`);
  if (isObject(s.items)) yield* subschemas(s.items, `${at}/items`);
  if (isObject(s.additionalProperties)) yield* subschemas(s.additionalProperties, `${at}/additionalProperties`);
}

/** What in the schema this validator cannot check, by where it is: empty when it can check it all. */
export function unsupported(schema: Schema): string[] {
  const out: string[] = [];
  for (const [at, s] of subschemas(schema)) {
    for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) out.push(`${at}: keyword ${k}`);
    if (s.type !== undefined) for (const t of [s.type].flat() as string[]) if (!TYPES.has(t)) out.push(`${at}: type ${t}`);
    if (s.$ref !== undefined && !/^#\/\$defs\/\w+$/.test(String(s.$ref))) out.push(`${at}: $ref ${String(s.$ref)}`);
    if (s.additionalProperties !== undefined && s.additionalProperties !== false && !isObject(s.additionalProperties)) out.push(`${at}: additionalProperties`);
  }
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") out.push("#: $schema is not draft 2020-12");
  return out;
}

/** Why `value` does not match `schema` (whose $refs point into `root`): empty when it does. */
export function schemaErrors(root: Schema, value: unknown, schema: Schema = root, at = "$"): string[] {
  const out: string[] = [];
  if (typeof schema.$ref === "string") out.push(...schemaErrors(root, value, schema.$ref.split("/").slice(1).reduce((x: Schema, k) => x[k] as Schema, root), at));
  if (schema.type !== undefined) {
    const types = [schema.type].flat() as string[];
    if (!types.some((t) => is(t, value))) return [...out, `${at}: not ${types.join(" or ")}`];
  }
  if ("const" in schema && !same(schema.const, value)) out.push(`${at}: not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) out.push(`${at}: not one of ${JSON.stringify(schema.enum)}`);
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  if (isObject(value)) {
    for (const k of (schema.required ?? []) as string[]) if (!(k in value)) out.push(`${at}: lacks ${k}`);
    const props = (schema.properties ?? {}) as Schema;
    for (const [k, x] of Object.entries(value)) {
      if (k in props) out.push(...schemaErrors(root, x, props[k] as Schema, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}: has ${k}`);
      else if (isObject(schema.additionalProperties)) out.push(...schemaErrors(root, x, schema.additionalProperties, `${at}.${k}`));
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) out.push(...value.flatMap((x, i) => schemaErrors(root, x, schema.items as Schema, `${at}[${i}]`)));
  return out;
}
