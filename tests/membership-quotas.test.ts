import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MEMBER_PLANS } from "../apps/api/src/billing.js";

test("V4 does not impose daily upload-count limits on any membership tier", async () => {
  const assets = await readFile(resolve("apps/api/src/assets.ts"), "utf8");
  const billing = await readFile(resolve("apps/api/src/billing.ts"), "utf8");
  const store = await readFile(resolve("apps/api/src/asset-store.ts"), "utf8");
  assert.doesNotMatch(assets, /DAILY_UPLOAD_LIMIT|dailyUploadLimit|createAssetsWithDailyLimit/);
  assert.doesNotMatch(billing, /DAILY_UPLOAD_LIMITS|dailyUploadLimitForMembership/);
  assert.doesNotMatch(store, /upload-quota|createAssetsWithDailyLimit/);
  assert.match(assets, /await options\.assetStore\.createAssets\(user\.id, records\)/);
  for (const plan of MEMBER_PLANS) {
    assert.ok(plan.description.length <= 15);
    assert.doesNotMatch(plan.description, /每日限|上传次数|上传限额/);
  }
});
