import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("manifest is a signed-ready Firefox Manifest V3 extension", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
  assert.equal(
    manifest.browser_specific_settings.gecko.id,
    "{a65bfc59-e31c-4b51-83e9-3a8de0311050}"
  );
  assert.deepEqual(
    manifest.browser_specific_settings.gecko.data_collection_permissions.required.sort(),
    ["authenticationInfo", "browsingActivity", "websiteContent"].sort()
  );
});

test("manifest does not request persistent page or browsing-history access", () => {
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(!manifest.permissions.includes("tabs"));
  assert.ok(!manifest.permissions.includes("history"));
  assert.equal(manifest.content_scripts, undefined);
});
