import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const resultValue = (body: string) =>
  onlyCallable(
    analyzeJavaScriptSemantics(`export function result() { ${body} }`),
    "result",
  ).returnSites[0]?.value;

const mutations = [
  'const options = { mode: "initial" }; options.mode = "updated"; return options.mode;',
  "const options = { count: 1 }; options.count += 1; return options.count;",
  "const options = { count: 1 }; options.count++; return options.count;",
  'const options = { mode: "initial" }; delete options.mode; return options.mode;',
  'const options = ["initial"]; options[0] = "updated"; return options[0];',
  'const options = { nested: { mode: "initial" } }; options.nested.mode = "updated"; return options.nested.mode;',
  'const options = { mode: "initial" }; const alias = options; alias.mode = "updated"; return options.mode;',
  'const options = { nested: { mode: "initial" } }; const { nested } = options; nested.mode = "updated"; return options.nested.mode;',
  'const nested = { mode: "initial" }; const options = { nested }; options.nested.mode = "updated"; return nested.mode;',
  'const options = { mode: "initial" }; [options.mode] = ["updated"]; return options.mode;',
  'const options = { mode: "initial" }; for (options.mode of ["updated"]) {} return options.mode;',
  'const options = { mode: "initial" }; const key = getKey(); options[key] = "updated"; return options.mode;',
];

describe("JavaScript semantic values after explicit property mutations", () => {
  it.each(mutations)("keeps the mutated value unknown: %s", (body) => {
    expect(resultValue(body)?.status).toBe("unknown");
  });

  it("keeps an unrelated shadowed object literal known", () => {
    expect(
      resultValue(`
      const options = { mode: "initial" };
      { const options = { mode: "inner" }; options.mode = "updated"; }
      return options.mode;
    `),
    ).toEqual({ status: "literal", value: "initial" });
  });

  it("keeps a copied primitive initializer known", () => {
    expect(
      resultValue(`
      const mode = "initial";
      const options = { mode };
      options.mode = "updated";
      return mode;
    `),
    ).toEqual({ status: "literal", value: "initial" });
  });

  it("retains ordinary immutable object and array projection", () => {
    expect(
      resultValue(
        'const options = { mode: ["initial"] }; return options.mode[0];',
      ),
    ).toEqual({ status: "literal", value: "initial" });
  });
});
