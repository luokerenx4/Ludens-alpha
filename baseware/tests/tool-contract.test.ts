import { expect, test } from "bun:test";
import { argumentValidator } from "../src/tool-contract.ts";

test("native 2020-12 constraints survive without coercing, removing or filling parameters", () => {
  const validate = argumentValidator({ name: "pointer", inputSchema: {
    type: "object", $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: { point: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false, minItems: 2 },
      down: { type: "boolean", default: false } }, required: ["point"], unevaluatedProperties: false,
  } });
  const args = { point: [2, 3] };
  expect(validate(args)).toBe(args);
  expect(args).toEqual({ point: [2, 3] });
  for (const invalid of [{ point: ["2", 3] }, { point: [2, 3, 4] }, { point: [2, 3], unsupported: 1 }, []])
    expect(() => validate(invalid)).toThrow();
});

test("explicit native draft-07 tuples retain their declared semantics", () => {
  const validate = argumentValidator({ name: "legacy_schema", inputSchema: {
    type: "object", $schema: "http://json-schema.org/draft-07/schema#",
    properties: { point: { type: "array", items: [{ type: "number" }, { type: "string" }], additionalItems: false } },
  } });
  expect(validate({ point: [1, "x"] })).toEqual({ point: [1, "x"] });
  expect(() => validate({ point: [1, 2] })).toThrow();
});
