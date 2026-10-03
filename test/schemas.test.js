// The mod registers its tools with JSON schemas generated from the zod schemas the daemon validates
// against; this fails when one changed without regenerating (npm run gen:schemas).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { render, target } from "../scripts/gen-schemas.mjs";

test("hooks/lib/schemas.gen.ts matches src/schema.js", () => {
  assert.equal(fs.readFileSync(target, "utf8"), render(), "run npm run gen:schemas");
});
