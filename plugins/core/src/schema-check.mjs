// A small JSON Schema validator for kit.json, so `kit doctor` needs no dependency once the plugin is
// installed. It covers the keywords schema/kit.schema.json uses: type, required, properties,
// additionalProperties (boolean or schema), propertyNames, items, minItems, uniqueItems, enum, const,
// pattern, minLength, minimum, maximum, anyOf, not and local `$ref`s (`#/$defs/...`). An unknown
// keyword is ignored, so a schema change that adds one needs a line here; tests/core-schema-check.test.mjs compares it with Ajv.

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: Array.isArray,
  string: (value) => typeof value === "string",
  integer: Number.isInteger,
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  null: (value) => value === null,
};

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

/**
 * Validate `value` against `schema`.
 * @param {unknown} value @param {Record<string, any>} schema
 * @returns {Array<{ path: string, message: string, keyword: string, key?: string }>} empty when valid
 */
export function validate(value, schema, root = schema, path = "") {
  const errors = [];
  const at = path || "/";
  if (schema.$ref) errors.push(...validate(value, resolveRef(root, schema.$ref), root, path));
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((branch) => validate(value, branch, root, path));
    // None fits: report the branch that came closest, so the message names the likely mistake.
    if (!branches.some((found) => found.length === 0)) {
      errors.push(...branches.reduce((best, found) => (found.length < best.length ? found : best)));
    }
  }
  if (schema.not && validate(value, schema.not, root, path).length === 0) {
    errors.push({ path: at, keyword: "not", message: "is not allowed here" });
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => TYPE_CHECKS[type]?.(value))) {
      errors.push({ path: at, keyword: "type", message: `must be ${types.join(" or ")}` });
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push({ path: at, keyword: "enum", message: `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}` });
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push({ path: at, keyword: "const", message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      errors.push({ path: at, keyword: "minLength", message: `must have at least ${schema.minLength} characters` });
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push({ path: at, keyword: "pattern", message: `must match ${schema.pattern}` });
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path: at, keyword: "minimum", message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path: at, keyword: "maximum", message: `must be <= ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: at, keyword: "minItems", message: `must have at least ${schema.minItems} item(s)` });
    }
    if (schema.items) value.forEach((item, index) => errors.push(...validate(item, schema.items, root, `${path}/${index}`)));
    if (schema.uniqueItems) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) errors.push({ path: at, keyword: "uniqueItems", message: "must not hold duplicates" });
    }
  }
  if (TYPE_CHECKS.object(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push({ path: at, keyword: "required", key, message: `must have property "${key}"` });
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames) {
        for (const error of validate(key, schema.propertyNames, root, `${path}/${key}`)) {
          errors.push({ ...error, keyword: "propertyNames", key, message: `name "${key}" ${error.message}` });
        }
      }
      if (key in properties) errors.push(...validate(child, properties[key], root, `${path}/${key}`));
      else if (schema.additionalProperties === false) {
        errors.push({ path: at, keyword: "additionalProperties", key, message: `unknown property "${key}"` });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(child, schema.additionalProperties, root, `${path}/${key}`));
      }
    }
  }
  return errors;
}
