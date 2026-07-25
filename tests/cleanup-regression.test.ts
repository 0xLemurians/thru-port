import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { validateNameLabel } from "../lib/thru/name-service/validation";

test("Source içinde hardcoded 'mert' bulunmaz", async () => {
  const formFile = await fs.readFile(
    path.join(process.cwd(), "components/name-studio/NameLookupForm.tsx"),
    "utf-8"
  );
  assert.equal(/placeholder="mert"/i.test(formFile), false);

  const dashFile = await fs.readFile(
    path.join(process.cwd(), "components/port/PortDashboard.tsx"),
    "utf-8"
  );
  assert.equal(/mert/i.test(dashFile), false);
});

test("Label input başlangıçta boştur", async () => {
  const studioFile = await fs.readFile(
    path.join(process.cwd(), "components/NameStudio.tsx"),
    "utf-8"
  );
  assert.ok(studioFile.includes('useState("")'), "Label input initial state is empty string");
});

test("Placeholder 'Enter label'dır", async () => {
  const formFile = await fs.readFile(
    path.join(process.cwd(), "components/name-studio/NameLookupForm.tsx"),
    "utf-8"
  );
  assert.ok(formFile.includes('placeholder="Enter label"'), "Placeholder is Enter label");
});

test("Dashboard metninde 'Developer tools' bulunmaz", async () => {
  const dashFile = await fs.readFile(
    path.join(process.cwd(), "components/port/PortDashboard.tsx"),
    "utf-8"
  );
  assert.equal(/Developer tools/i.test(dashFile), false);
  assert.ok(dashFile.includes("Use the navigation above to continue to Tokens or Identity."));
});

test("Metadata title yeni ürün adıdır", async () => {
  const layoutFile = await fs.readFile(
    path.join(process.cwd(), "app/layout.tsx"),
    "utf-8"
  );
  assert.ok(layoutFile.includes('title: "Thru Port — AlphaNet Wallet & Token Studio"'));
});

test("Local label derivation deterministiktir", () => {
  const label = "testlabel";
  const res1 = validateNameLabel(label);
  const res2 = validateNameLabel(label);
  assert.equal(res1.label, "testlabel");
  assert.deepEqual(res1.bytes, res2.bytes);

  const diffRes = validateNameLabel("otherlabel");
  assert.notDeepEqual(res1.bytes, diffRes.bytes);
});

test("Empty label güvenli davranır", () => {
  assert.throws(() => validateNameLabel(""), /required/i);
  assert.throws(() => validateNameLabel("   "), /required/i);
});

test("Safety rail metni şifreli IndexedDB saklamasını belirtir", async () => {
  const railFile = await fs.readFile(
    path.join(process.cwd(), "components/port/PortSafetyRail.tsx"),
    "utf-8"
  );
  assert.ok(railFile.includes("ENCRYPTED ON THIS DEVICE"));
  assert.ok(railFile.includes("Wallet material is stored encrypted in this browser"));
  assert.equal(/KEYS STAY ON DEVICE/i.test(railFile), false);
  assert.equal(/browser memory/i.test(railFile), false);
});
