import { test } from "node:test";
import assert from "node:assert/strict";
import { localDashboardLink } from "../lib/desktop";

test("desktop notifications retain local run links and reject outside origins", () => {
  const base = "http://127.0.0.1:3015/?view=settings";
  const target =
    "http://127.0.0.1:3015/?project=ws&run=one&epoch=two&view=live&block=tool%3A1";
  assert.equal(localDashboardLink(target, base), target);
  assert.equal(localDashboardLink("https://example.com", base), null);
  assert.equal(localDashboardLink("javascript:alert(1)", base), null);
  assert.equal(localDashboardLink("http://user@127.0.0.1:3015/", base), null);
});
