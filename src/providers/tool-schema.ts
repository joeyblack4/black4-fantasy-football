/** Advertise object-root function parameters; each tool still validates its exact union. */
export function objectToolParameters(
  schema: Record<string, any>,
): Record<string, any> {
  if (schema.type === "object") return schema;
  const branches = schema.oneOf ?? schema.anyOf;
  if (
    !Array.isArray(branches) ||
    !branches.length ||
    branches.some((b) => b.type !== "object")
  )
    throw new Error("TOOL_OBJECT_SCHEMA_REQUIRED");
  const properties: Record<string, any> = {};
  for (const branch of branches)
    for (const [key, value] of Object.entries(branch.properties ?? {})) {
      if (!(key in properties)) properties[key] = value;
      else if (JSON.stringify(properties[key]) !== JSON.stringify(value)) {
        const variants = properties[key].anyOf ?? [properties[key]];
        if (
          !variants.some(
            (v: unknown) => JSON.stringify(v) === JSON.stringify(value),
          )
        )
          properties[key] = { anyOf: [...variants, value] };
      }
    }
  return {
    type: "object",
    properties,
    required: (branches[0].required ?? []).filter((key: string) =>
      branches.every((b) => (b.required ?? []).includes(key)),
    ),
    additionalProperties: false,
  };
}

/** Safe validation metadata: schema-owned field names and types, never argument values. */
export function safeValidationIssues(
  schema: Record<string, any>,
  error: unknown,
) {
  const known = new Set<string>([
    "actions",
    "summary",
    "type",
    "key",
    "content",
    "version",
    "causalId",
  ]);
  const collect = (node: any, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 20) return;
    for (const key of Object.keys(node.properties ?? {})) known.add(key);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((v) => collect(v, depth + 1));
      else if (value && typeof value === "object") collect(value, depth + 1);
    }
  };
  collect(schema);
  const result: Record<string, unknown>[] = [];
  const visit = (issues: any[], depth = 0) => {
    for (const issue of issues) {
      if (result.length >= 12 || depth > 5) return;
      result.push({
        code:
          typeof issue.code === "string" && /^[a-z_]{1,40}$/.test(issue.code)
            ? issue.code
            : "validation_error",
        path: (Array.isArray(issue.path) ? issue.path : [])
          .slice(0, 12)
          .map((p: unknown) =>
            typeof p === "number"
              ? p
              : typeof p === "string" && known.has(p)
                ? p
                : "[unknown-field]",
          ),
        ...(typeof issue.expected === "string" &&
        [
          "string",
          "number",
          "boolean",
          "object",
          "array",
          "null",
          "undefined",
          "int",
          "bigint",
          "date",
        ].includes(issue.expected)
          ? { expectedType: issue.expected }
          : {}),
        ...(Array.isArray(issue.keys)
          ? {
              unrecognizedFields: issue.keys
                .slice(0, 12)
                .map((key: unknown) =>
                  typeof key === "string" && known.has(key)
                    ? key
                    : "[unknown-field]",
                ),
              unrecognizedFieldCount: issue.keys.length,
            }
          : {}),
      });
      if (Array.isArray(issue.errors))
        for (const nested of issue.errors)
          if (Array.isArray(nested)) visit(nested, depth + 1);
    }
  };
  if (
    error &&
    typeof error === "object" &&
    Array.isArray((error as any).issues)
  )
    visit((error as any).issues);
  return result;
}
export function safeToolArgumentShape(
  schema: Record<string, any>,
  value: unknown,
) {
  const kind = (v: unknown) =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const object =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const properties = objectToolParameters(schema).properties ?? {};
  const keys = Object.keys(object);
  return {
    argumentType: kind(value),
    providedFields: keys
      .filter((k) => Object.hasOwn(properties, k))
      .sort()
      .slice(0, 32)
      .map((key) => ({ key, type: kind(object[key]) })),
    unknownFieldCount: keys.filter((k) => !Object.hasOwn(properties, k)).length,
  };
}
