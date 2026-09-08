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
