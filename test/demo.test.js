import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDirectory = mkdtempSync(join(tmpdir(), "hcm-lite-demo-test-"));
process.env.DATABASE_PATH = join(testDirectory, "demo.sqlite");
process.env.JWT_SECRET = "demo-test-secret-with-at-least-thirty-two-characters";
process.env.NODE_ENV = "test";
process.env.ENABLE_DEMO_DATA = "true";

const { default: app } = await import("../server/app.js");
const { db } = await import("../server/db.js");
let server;
let baseUrl;
let adminCookie;

async function request(path, { cookie, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}/api${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const setup = await request("/setup", {
    method: "POST",
    body: JSON.stringify({
      company: "Demo Test Studio",
      name: "Demo Admin",
      email: "admin@example.com",
      password: "a-long-test-admin-password",
    }),
  });
  assert.equal(setup.response.status, 201);
  adminCookie = setup.response.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

test("demo seeding adds fictional sample records only once", async () => {
  const beforeSeed = await request("/bootstrap", { cookie: adminCookie });
  assert.equal(beforeSeed.body.demoDataEnabled, true);
  assert.deepEqual(beforeSeed.body.employees, []);

  const seeded = await request("/demo/seed", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({}),
  });
  assert.equal(seeded.response.status, 201);
  assert.equal(seeded.body.employees, 3);

  const bootstrap = await request("/bootstrap", { cookie: adminCookie });
  assert.equal(bootstrap.body.employees.length, 3);
  assert.equal(bootstrap.body.attendance.length, 2);
  assert.equal(bootstrap.body.leaves.length, 1);
  assert.equal(bootstrap.body.announcements.length, 1);

  const duplicate = await request("/demo/seed", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({}),
  });
  assert.equal(duplicate.response.status, 409);
});
