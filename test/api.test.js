import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDirectory = mkdtempSync(join(tmpdir(), "hcm-lite-test-"));
process.env.DATABASE_PATH = join(testDirectory, "test.sqlite");
process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GITHUB_CLIENT_ID = "";
process.env.GITHUB_CLIENT_SECRET = "";
process.env.ENABLE_DEMO_DATA = "false";

const { default: app } = await import("../server/app.js");
const { db } = await import("../server/db.js");
const { copilotClient, decryptCopilotAccessToken, encryptCopilotAccessToken, getCopilotErrorMessage } = await import("../server/copilot.js");
const { isImageGenerationRequest, isNewImageRequest } = await import("../server/imageGeneration.js");
const { getBillingStatus, hasCurrentMonthPayment, isMonthlyPaymentRequired } = await import("../server/billing.js");
const { averageFaceDescriptors, faceDescriptorDistance } = await import("../src/faceRecognition.js");
let server;
let baseUrl;
let adminCookie;
let employeeCookie;
let employeeId;
let employeeSignupCode;

async function request(path, { cookie, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}/api${path}`, { ...options, headers });
  const text = await response.text();
  const body = !text ? null
    : response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
  return { response, body };
}

async function payMonthlyFee(cookie, transactionReference) {
  const billingStatus = await request("/billing/current", { cookie });
  if (!billingStatus.body.billing.required) {
    const workspace = await request("/employees", { cookie });
    assert.equal(workspace.response.status, 200);
    return;
  }
  const invoice = await request("/billing/request", {
    method: "POST",
    cookie,
    body: JSON.stringify({}),
  });
  assert.equal(invoice.response.status, 201);
  const submitted = await request(`/billing/payments/${encodeURIComponent(invoice.body.payment.id)}/submit`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ transactionReference }),
  });
  assert.equal(submitted.response.status, 200);
  const locked = await request("/employees", { cookie });
  assert.equal(locked.response.status, 402);
  const reviewQueue = await request("/billing/payments", { cookie: adminCookie });
  assert.ok(reviewQueue.body.billing.reviewQueue.some((payment) => payment.id === invoice.body.payment.id
    && payment.transactionReference === transactionReference));
  const rejected = await request(`/billing/payments/${encodeURIComponent(invoice.body.payment.id)}/review`, {
    method: "PATCH",
    cookie: adminCookie,
    body: JSON.stringify({ status: "rejected" }),
  });
  assert.equal(rejected.response.status, 200);
  const resubmitted = await request(`/billing/payments/${encodeURIComponent(invoice.body.payment.id)}/submit`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ transactionReference: `${transactionReference}-retry` }),
  });
  assert.equal(resubmitted.response.status, 200);
  const approved = await request(`/billing/payments/${encodeURIComponent(invoice.body.payment.id)}/review`, {
    method: "PATCH",
    cookie: adminCookie,
    body: JSON.stringify({ status: "paid" }),
  });
  assert.equal(approved.response.status, 200);
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

test("monthly billing starts after November 20 and recurs after the 20th", () => {
  const beforeCutoff = new Date("2026-11-20T18:59:59.999Z");
  const afterCutoff = new Date("2026-11-20T19:00:00.000Z");
  assert.equal(isMonthlyPaymentRequired(beforeCutoff), false);
  assert.equal(isMonthlyPaymentRequired(afterCutoff), true);
  assert.equal(isMonthlyPaymentRequired(new Date("2026-12-20T18:59:59.999Z")), false);
  assert.equal(isMonthlyPaymentRequired(new Date("2026-12-20T19:00:00.000Z")), true);
  assert.equal(hasCurrentMonthPayment("unpaid-test-user", beforeCutoff), true);
  assert.equal(hasCurrentMonthPayment("unpaid-test-user", afterCutoff), false);
  assert.equal(getBillingStatus({ id: "unpaid-test-user", role: "employee" }, beforeCutoff).paid, true);
  assert.equal(getBillingStatus({ id: "unpaid-test-user", role: "employee" }, afterCutoff).paid, false);
});

test("face templates average three samples and compare matching vectors", () => {
  assert.deepEqual(averageFaceDescriptors([[1, 2], [3, 4], [5, 6]]), [3, 4]);
  assert.equal(faceDescriptorDistance([0, 0], [3, 4]), 5);
  assert.throws(() => averageFaceDescriptors([[1, 2], [3, 4]]), /three clear face samples/i);
  assert.throws(() => faceDescriptorDistance([1], [1, 2]), /invalid/i);
});

test("Copilot OAuth tokens are encrypted and authenticated before use", () => {
  const accessToken = "gho-test-copilot-token";
  const encrypted = encryptCopilotAccessToken(accessToken);
  assert.notEqual(encrypted, accessToken);
  assert.equal(decryptCopilotAccessToken(encrypted), accessToken);
  process.env.JWT_SECRET = "a-different-stable-secret-for-test-encryption";
  assert.throws(() => decryptCopilotAccessToken(encrypted));
  process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
});

test("Google sign-in requires explicit server configuration", async () => {
  const config = await request("/auth/google/config");
  assert.equal(config.response.status, 200);
  assert.equal(config.body.enabled, false);
  assert.equal(config.body.clientId, null);

  const nonce = await request("/auth/google/nonce");
  assert.equal(nonce.response.status, 503);
  assert.equal(nonce.body.error, "Google sign-in needs a valid Google Web Client ID in the server .env file.");

  const signIn = await request("/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential: "fake-google-credential".repeat(10), nonce: "a-valid-looking-nonce-with-enough-length" }),
  });
  assert.equal(signIn.response.status, 503);

  process.env.GOOGLE_CLIENT_ID = "malformed-client-id";
  const invalidConfig = await request("/auth/google/config");
  assert.equal(invalidConfig.body.enabled, false);
  const invalidNonce = await request("/auth/google/nonce");
  assert.equal(invalidNonce.response.status, 503);

  process.env.GOOGLE_CLIENT_ID = "123456789012-example.apps.googleusercontent.com";
  const configuredNonce = await request("/auth/google/nonce");
  assert.equal(configuredNonce.response.status, 200);
  assert.ok(configuredNonce.body.nonce.length >= 20);
  const googleSignupWithoutPhone = await request("/auth/google", {
    method: "POST",
    body: JSON.stringify({
      credential: "fake-google-credential".repeat(10),
      nonce: "a-valid-looking-nonce-with-enough-length",
      role: "employee",
      email: "employee@example.com",
      signupCode: "a-valid-looking-invite-code-that-is-long-enough",
    }),
  });
  assert.equal(googleSignupWithoutPhone.response.status, 400);
  assert.match(googleSignupWithoutPhone.body.error, /mobile number/i);
  const nonceCookie = configuredNonce.response.headers.get("set-cookie").split(";")[0];
  const invalidCredential = await request("/auth/google", {
    method: "POST",
    cookie: nonceCookie,
    body: JSON.stringify({ credential: "not-a-valid-google-id-token".repeat(8), nonce: configuredNonce.body.nonce }),
  });
  assert.equal(invalidCredential.response.status, 401);
  process.env.GOOGLE_CLIENT_ID = "";
});

test("GitHub OAuth requires credentials and validates signup invitations", async () => {
  const providers = await request("/auth/providers");
  assert.deepEqual(providers.body, { github: false });

  const unsupportedProvider = await request("/auth/facebook/start", {
    method: "POST",
    body: JSON.stringify({ mode: "login" }),
  });
  assert.equal(unsupportedProvider.response.status, 404);

  const unconfigured = await request("/auth/github/start", {
    method: "POST",
    body: JSON.stringify({ mode: "login" }),
  });
  assert.equal(unconfigured.response.status, 503);

  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
  const configured = await request("/auth/providers");
  assert.deepEqual(configured.body, { github: true });

  const signupWithoutInvite = await request("/auth/github/start", {
    method: "POST",
    body: JSON.stringify({ mode: "signup" }),
  });
  assert.equal(signupWithoutInvite.response.status, 400);

  const githubStart = await request("/auth/github/start", {
    method: "POST",
    body: JSON.stringify({ mode: "login" }),
  });
  assert.equal(githubStart.response.status, 200);
  const githubUrl = new URL(githubStart.body.url);
  assert.equal(githubUrl.origin, "https://github.com");
  assert.equal(githubUrl.searchParams.get("redirect_uri"), "http://localhost:3001/api/auth/github/callback");

  process.env.GITHUB_CLIENT_ID = "";
  process.env.GITHUB_CLIENT_SECRET = "";
});

test("a fresh workspace requires authentication and creates one first admin", async () => {
  const status = await request("/setup/status");
  assert.equal(status.body.configured, false);

  const noSession = await request("/auth/me");
  assert.equal(noSession.response.status, 204);

  const unauthenticated = await request("/employees");
  assert.equal(unauthenticated.response.status, 401);

  const created = await request("/setup", {
    method: "POST",
    body: JSON.stringify({
      company: "Northstar Studio",
      name: "Sana Ahmed",
      email: "sana@example.com",
      password: "very-long-test-password",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.user.role, "admin");
  adminCookie = created.response.headers.get("set-cookie").split(";")[0];
  const billingSettings = await request("/billing/settings", {
    method: "PUT",
    cookie: adminCookie,
    body: JSON.stringify({ easypaisaAccount: "03001234567", monthlyFee: 1000 }),
  });
  assert.equal(billingSettings.response.status, 200);
  assert.equal(billingSettings.body.billing.monthlyFee, 1000);

  const duplicate = await request("/setup", {
    method: "POST",
    body: JSON.stringify({
      company: "Another Studio",
      name: "Other Admin",
      email: "other@example.com",
      password: "another-long-password",
    }),
  });
  assert.equal(duplicate.response.status, 409);
});

test("demo sample data is disabled unless the server explicitly enables it", async () => {
  const bootstrap = await request("/bootstrap", { cookie: adminCookie });
  assert.equal(bootstrap.body.demoDataEnabled, false);
  const seed = await request("/demo/seed", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({}),
  });
  assert.equal(seed.response.status, 403);
});

test("employee invitations are role-bound and activate through one-time sign-up", async () => {
  const invited = await request("/employees", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({
      name: "Aisha Khan",
      email: "aisha@example.com",
      department: "Design",
      title: "Product Designer",
      salary: 145000,
    }),
  });
  assert.equal(invited.response.status, 201);
  employeeId = invited.body.employee.id;
  employeeSignupCode = invited.body.signupCode;
  assert.ok(employeeSignupCode.length >= 20);
  assert.equal(invited.body.temporaryPassword, undefined);
  assert.equal(invited.body.employee.salary, 145000);

  const codeIsNotPassword = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "aisha@example.com", password: employeeSignupCode }),
  });
  assert.equal(codeIsNotPassword.response.status, 401);

  const signupWithoutPhone = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      role: "employee",
      email: "aisha@example.com",
      signupCode: employeeSignupCode,
      password: "my-own-long-password",
    }),
  });
  assert.equal(signupWithoutPhone.response.status, 400);
  assert.match(signupWithoutPhone.body.error, /phone|mobile/i);

  const signup = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      role: "employee",
      email: "aisha@example.com",
      signupCode: employeeSignupCode,
      password: "my-own-long-password",
      phone: "+92 300 1112233",
    }),
  });
  assert.equal(signup.response.status, 201);
  assert.equal(signup.body.user.role, "employee");
  assert.equal(signup.body.user.mustChangePassword, 0);
  assert.equal(signup.body.user.phone, "+92 300 1112233");
  employeeCookie = signup.response.headers.get("set-cookie").split(";")[0];
  const currentBilling = await request("/billing/current", { cookie: employeeCookie });
  assert.equal(currentBilling.response.status, 200);
  if (!currentBilling.body.billing.required) {
    const availableWorkspace = await request("/employees", { cookie: employeeCookie });
    assert.equal(availableWorkspace.response.status, 200);
    const earlyPayment = await request("/billing/request", {
      method: "POST",
      cookie: employeeCookie,
      body: JSON.stringify({}),
    });
    assert.equal(earlyPayment.response.status, 409);
    return;
  }
  const firstPaymentId = await request("/billing/request", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({}),
  });
  assert.equal(firstPaymentId.response.status, 201);
  assert.equal(firstPaymentId.body.payment.amount, 1000);
  assert.equal(firstPaymentId.body.payment.receiverAccount, "03001234567");
  const repeatedPaymentId = await request("/billing/request", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({}),
  });
  assert.equal(repeatedPaymentId.body.payment.id, firstPaymentId.body.payment.id);
  db.prepare("UPDATE monthly_payments SET expires_at = '2000-01-01' WHERE id = ?").run(firstPaymentId.body.payment.id);
  const expiredPayment = await request("/billing/current", { cookie: employeeCookie });
  assert.equal(expiredPayment.body.billing.payment.status, "expired");
  const renewedPayment = await request("/billing/request", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({}),
  });
  assert.notEqual(renewedPayment.body.payment.id, firstPaymentId.body.payment.id);
  const lockedWorkspace = await request("/employees", { cookie: employeeCookie });
  assert.equal(lockedWorkspace.response.status, 402);
  assert.equal(lockedWorkspace.body.code, "PAYMENT_REQUIRED");
  await payMonthlyFee(employeeCookie, "EP-TEST-EMPLOYEE-0001");
  const unlockedWorkspace = await request("/employees", { cookie: employeeCookie });
  assert.equal(unlockedWorkspace.response.status, 200);
});

test("HR and employee sign-up requires a matching, one-time invitation", async () => {
  const invitation = await request("/users/hr", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({ name: "Maham Ali", email: "maham@example.com" }),
  });
  assert.equal(invitation.response.status, 201);
  assert.equal(invitation.body.user.role, "hr");
  assert.equal(invitation.body.temporaryPassword, undefined);
  assert.ok(invitation.body.signupCode.length >= 20);

  const wrongRole = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      role: "employee",
      email: "maham@example.com",
      signupCode: invitation.body.signupCode,
      password: "a-long-signup-password",
    }),
  });
  assert.equal(wrongRole.response.status, 400);

  const adminSignup = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      role: "admin",
      email: "maham@example.com",
      signupCode: invitation.body.signupCode,
      password: "a-long-signup-password",
      phone: "03001234567",
    }),
  });
  assert.equal(adminSignup.response.status, 403);

  const signup = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      role: "hr",
      email: "maham@example.com",
      signupCode: invitation.body.signupCode,
      password: "a-long-signup-password",
      phone: "03001234568",
    }),
  });
  assert.equal(signup.response.status, 201);
  assert.equal(signup.body.user.role, "hr");
  assert.equal(signup.body.user.mustChangePassword, 0);
  const hrCookie = signup.response.headers.get("set-cookie").split(";")[0];
  await payMonthlyFee(hrCookie, "EP-TEST-HR-00001");
  const hrCannotCreateAdmin = await request("/users/hr", {
    method: "POST",
    cookie: hrCookie,
    body: JSON.stringify({ name: "Other HR", email: "other-hr@example.com" }),
  });
  assert.equal(hrCannotCreateAdmin.response.status, 403);

  const reusedEmployeeCode = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      role: "employee",
      email: "aisha@example.com",
      signupCode: employeeSignupCode,
      password: "another-employee-password",
    }),
  });
  assert.equal(reusedEmployeeCode.response.status, 400);

  const reusedCode = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      role: "hr",
      email: "maham@example.com",
      signupCode: invitation.body.signupCode,
      password: "another-long-signup-password",
    }),
  });
  assert.equal(reusedCode.response.status, 400);
});

test("employee data scope and server-side workflow permissions are enforced", async () => {
  const ownEmployees = await request("/employees", { cookie: employeeCookie });
  assert.equal(ownEmployees.response.status, 200);
  assert.equal(ownEmployees.body.employees.length, 1);
  assert.equal(ownEmployees.body.employees[0].id, employeeId);
  assert.equal(Object.hasOwn(ownEmployees.body.employees[0], "salary"), false);

  const profile = await request("/profile", { cookie: employeeCookie });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.profile.email, "aisha@example.com");
  const savedProfile = await request("/profile", {
    method: "PATCH",
    cookie: employeeCookie,
    body: JSON.stringify({ phone: "+92 300 0000000", address: "Karachi" }),
  });
  assert.equal(savedProfile.response.status, 200);
  assert.equal(savedProfile.body.profile.phone, "+92 300 0000000");
  const refreshedProfile = await request("/profile", { cookie: employeeCookie });
  assert.equal(refreshedProfile.body.profile.address, "Karachi");

  const cameraCheckIn = await request("/attendance/check-in", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({ employeeId: "another-user", name: "Someone Else" }),
  });
  assert.equal(cameraCheckIn.response.status, 201);
  const ownAttendance = await request("/attendance", { cookie: employeeCookie });
  assert.equal(ownAttendance.body.attendance.length, 1);
  assert.equal(ownAttendance.body.attendance[0].employeeId, employeeId);
  assert.equal(ownAttendance.body.attendance[0].name, "Aisha Khan");

  const createEmployeeDenied = await request("/employees", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({}),
  });
  assert.equal(createEmployeeDenied.response.status, 403);

  const leave = await request("/leave", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({
      type: "Casual",
      start: "2026-11-02",
      end: "2026-11-03",
      reason: "Family time",
    }),
  });
  assert.equal(leave.response.status, 201);
  assert.equal(leave.body.days, 2);
  assert.equal(leave.body.status, "Pending");

  const employeeCannotReviewOwnLeave = await request(`/leave/${leave.body.id}`, {
    method: "PATCH",
    cookie: employeeCookie,
    body: JSON.stringify({ status: "Approved", comment: "Approved." }),
  });
  assert.equal(employeeCannotReviewOwnLeave.response.status, 403);

  const adminReview = await request(`/leave/${leave.body.id}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: JSON.stringify({ status: "Approved", comment: "Your leave is approved." }),
  });
  assert.equal(adminReview.response.status, 200);
  assert.equal(adminReview.body.status, "Approved");
  const approvedForEmployee = await request("/leave", { cookie: employeeCookie });
  assert.equal(approvedForEmployee.body.leaves[0].reviewComment, "Your leave is approved.");

  const changedPassword = await request("/auth/change-password", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({ currentPassword: "my-own-long-password", newPassword: "employee-updated-password-2026" }),
  });
  assert.equal(changedPassword.response.status, 200);
  const newPasswordLogin = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "aisha@example.com", password: "employee-updated-password-2026" }),
  });
  assert.equal(newPasswordLogin.response.status, 200);

  const peerPayroll = await request("/payroll", { cookie: employeeCookie });
  assert.equal(peerPayroll.response.status, 200);
  assert.deepEqual(peerPayroll.body.payslips, []);
});

test("payroll locking, audit logs and AI answers remain role scoped", async () => {
  const run = await request("/payroll/run", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({ month: "2026-11" }),
  });
  assert.equal(run.response.status, 201);
  assert.equal(run.body.status, "Draft");

  const employeeFinalize = await request(`/payroll/${run.body.id}/finalize`, {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({}),
  });
  assert.equal(employeeFinalize.response.status, 403);

  const finalized = await request(`/payroll/${run.body.id}/finalize`, {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({}),
  });
  assert.equal(finalized.body.status, "Finalized");

  const employeeAnswer = await request("/ai/chat", {
    method: "POST",
    cookie: employeeCookie,
    body: JSON.stringify({ question: "What is another colleague's salary?" }),
  });
  assert.match(employeeAnswer.body.answer, /can’t share another person/i);

  const audit = await request("/audit", { cookie: employeeCookie });
  assert.equal(audit.response.status, 403);
  const adminAudit = await request("/audit", { cookie: adminCookie });
  assert.equal(adminAudit.response.status, 200);
  assert.ok(adminAudit.body.logs.some((item) => item.action === "payroll.finalized"));
});

test("GitHub Copilot OAuth connects the signed-in HCM user and encrypts their token", async () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.GITHUB_CLIENT_ID;
  const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const originalCallbackBase = process.env.OAUTH_CALLBACK_BASE_URL;
  const originalAppOrigin = process.env.APP_ORIGIN;
  process.env.GITHUB_CLIENT_ID = "test-github-oauth-client";
  process.env.GITHUB_CLIENT_SECRET = "test-github-oauth-secret";
  process.env.OAUTH_CALLBACK_BASE_URL = "http://localhost:3001";
  process.env.APP_ORIGIN = "http://localhost:3000";
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho-user-copilot-token" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: 789, login: "copilot-user", name: "Copilot User" });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([{ email: "sana@example.com", primary: true, verified: true }]);
    }
    return originalFetch(input, options);
  };
  try {
    const start = await request("/ai/copilot/connect", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({}),
    });
    assert.equal(start.response.status, 200, `${start.response.url} ${JSON.stringify(start.body)}`);
    const authorization = new URL(start.body.url);
    assert.equal(authorization.origin, "https://github.com");
    assert.equal(authorization.searchParams.get("redirect_uri"), "http://localhost:3001/api/ai/copilot/callback");
    assert.equal(authorization.searchParams.get("scope"), "read:user user:email");
    const state = authorization.searchParams.get("state");
    const stateCookie = start.response.headers.get("set-cookie").split(";")[0];

    const callback = await request(`/ai/copilot/callback?code=test-oauth-code&state=${encodeURIComponent(state)}`, {
      cookie: stateCookie,
      redirect: "manual",
    });
    assert.equal(callback.response.status, 302);
    assert.equal(callback.response.headers.get("location"), "http://localhost:3000/HCM?copilot_connected=true");

    const adminId = db.prepare("SELECT id FROM users WHERE email = ?").get("sana@example.com").id;
    const saved = db.prepare("SELECT copilot_access_token AS token, copilot_github_sub AS githubSub FROM users WHERE id = ?").get(adminId);
    assert.notEqual(saved.token, "gho-user-copilot-token");
    assert.equal(decryptCopilotAccessToken(saved.token), "gho-user-copilot-token");
    assert.equal(saved.githubSub, "789");
    const status = await request("/ai/copilot/status", { cookie: adminCookie });
    assert.equal(status.body.connected, true);

    const disconnected = await request("/ai/copilot/connect", { method: "DELETE", cookie: adminCookie });
    assert.equal(disconnected.response.status, 200);
    assert.equal(disconnected.body.connected, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = originalClientSecret;
    if (originalCallbackBase === undefined) delete process.env.OAUTH_CALLBACK_BASE_URL;
    else process.env.OAUTH_CALLBACK_BASE_URL = originalCallbackBase;
    if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = originalAppOrigin;
  }
});

test("GitHub Copilot chat uses only the signed-in user's token and has no tools", async () => {
  const originalStart = copilotClient.start;
  const originalCreateSession = copilotClient.createSession;
  const accessToken = "gho-user-scoped-token";
  const adminId = db.prepare("SELECT id FROM users WHERE email = ?").get("sana@example.com").id;
  db.prepare("UPDATE users SET copilot_access_token = ?, copilot_github_sub = ? WHERE id = ?")
    .run(encryptCopilotAccessToken(accessToken), "copilot-test-user", adminId);
  let sessionConfig;
  let submittedPrompt;
  copilotClient.start = async () => {};
  copilotClient.createSession = async (config) => {
    sessionConfig = config;
    return {
      sendAndWait: async ({ prompt }) => {
        submittedPrompt = prompt;
        return { data: { content: "Hello from GitHub Copilot." } };
      },
      on: (eventName, handler) => {
        assert.equal(eventName, "tool.execution_complete");
        assert.equal(typeof handler, "function");
        return () => {};
      },
      disconnect: async () => {},
    };
  };
  try {
    const response = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({ question: "How many people are active?" }),
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.body.answer, "Hello from GitHub Copilot.");
    assert.equal(response.body.mode, "copilot");
    assert.equal(sessionConfig.gitHubToken, accessToken);
    assert.deepEqual(sessionConfig.availableTools, []);
    assert.deepEqual(sessionConfig.imageGeneration, { enabled: true, watermark: true, saveToDisk: false });
    assert.match(sessionConfig.systemMessage.content, /Permission-scoped workspace data/);
    assert.equal(submittedPrompt, "How many people are active?");
  } finally {
    copilotClient.start = originalStart;
    copilotClient.createSession = originalCreateSession;
    db.prepare("UPDATE users SET copilot_access_token = NULL, copilot_github_sub = NULL WHERE id = ?").run(adminId);
  }
});

test("Copilot quota failures explain the actual limit instead of asking for reconnection", async () => {
  const originalStart = copilotClient.start;
  const originalCreateSession = copilotClient.createSession;
  const adminId = db.prepare("SELECT id FROM users WHERE email = ?").get("sana@example.com").id;
  db.prepare("UPDATE users SET copilot_access_token = ?, copilot_github_sub = ? WHERE id = ?")
    .run(encryptCopilotAccessToken("gho-user-quota-token"), "copilot-quota-test-user", adminId);
  copilotClient.start = async () => {};
  copilotClient.createSession = async () => {
    throw new Error("You have exceeded your monthly quota");
  };
  try {
    const response = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({ question: "Say hello" }),
    });
    assert.equal(response.response.status, 502);
    assert.match(response.body.error, /usage quota\/limit khatam/i);
    assert.doesNotMatch(response.body.error, /reconnect/i);
    const saved = await request(`/ai/conversations/${response.body.conversationId}/messages`, { cookie: adminCookie });
    assert.match(saved.body.messages.at(-1).text, /usage quota\/limit khatam/i);
  } finally {
    copilotClient.start = originalStart;
    copilotClient.createSession = originalCreateSession;
    db.prepare("UPDATE users SET copilot_access_token = NULL, copilot_github_sub = NULL WHERE id = ?").run(adminId);
  }
  assert.match(getCopilotErrorMessage(new Error("HTTP 403 forbidden")), /subscription/i);
});

test("Copilot chat requires a linked account instead of returning a fake answer", async () => {
  const connection = await request("/ai/copilot/connect", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({}),
  });
  assert.equal(connection.response.status, 503);
  assert.match(connection.body.error, /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET/i);

  const response = await request("/ai/chat", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({ question: "How many people are active?" }),
  });
  assert.equal(response.response.status, 409);
  assert.match(response.body.error, /Connect your own GitHub Copilot account/i);
  assert.equal(response.body.answer, undefined);
});

test("Local ComfyUI image requests generate and edit images without API billing", async () => {
  const originalFetch = globalThis.fetch;
  const originalComfyUrl = process.env.COMFYUI_URL;
  const originalComfyCheckpoint = process.env.COMFYUI_CHECKPOINT;
  const generatedPng = Buffer.from("generated-png-image-data");
  const calls = [];
  let promptCount = 0;
  process.env.COMFYUI_URL = "http://127.0.0.1:8188";
  delete process.env.COMFYUI_CHECKPOINT;
  assert.equal(isImageGenerationRequest("Enhance this img", [{ mimeType: "image/png" }]), true);
  assert.equal(isImageGenerationRequest("How many people are here?", []), false);
  assert.equal(isNewImageRequest("Create a new image of a leaf"), true);
  assert.equal(isNewImageRequest("Enhance this img"), false);
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (!url.startsWith(process.env.COMFYUI_URL)) return originalFetch(input, options);
    calls.push({ url, options });
    if (url.endsWith("/object_info/CheckpointLoaderSimple")) {
      return Response.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["test-model.safetensors"]] } } } });
    }
    if (url.endsWith("/upload/image")) {
      const upload = options.body.get("image");
      assert.equal(upload.name, "reference.png");
      assert.equal(await upload.text(), "source-image");
      return Response.json({ name: "reference.png", subfolder: "", type: "input" });
    }
    if (url.endsWith("/prompt")) {
      const { prompt } = JSON.parse(options.body);
      promptCount += 1;
      if (prompt["4"]) assert.equal(prompt["4"].class_type, "LoadImage");
      else assert.equal(prompt["6"].class_type, "EmptyLatentImage");
      return Response.json({ prompt_id: `test-prompt-${promptCount}` });
    }
    if (url.includes("/history/")) {
      const id = url.split("/").pop();
      return Response.json({ [id]: { outputs: { "8": { images: [{ filename: `${id}.png`, subfolder: "", type: "output" }] } } } });
    }
    if (url.includes("/view?")) return new Response(generatedPng, { headers: { "Content-Type": "image/png" } });
    throw new Error(`Unexpected ComfyUI request: ${url}`);
  };
  try {
    const edit = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({
        question: "Enhance this img",
        attachments: [{
          name: "reference.png",
          mimeType: "image/png",
          contentBase64: Buffer.from("source-image").toString("base64"),
        }],
      }),
    });
    assert.equal(edit.response.status, 200);
    assert.equal(edit.body.mode, "image-generation");
    assert.equal(edit.body.model, "test-model.safetensors");
    assert.ok(calls.some(({ url }) => url.endsWith("/upload/image")));
    const editWorkflow = JSON.parse(calls.find(({ url }) => url.endsWith("/prompt")).options.body).prompt;
    assert.equal(editWorkflow["5"].inputs.denoise, 0.62);
    assert.equal(editWorkflow["4"].inputs.image, "reference.png");

    const create = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({
        conversationId: edit.body.conversationId,
        question: "Create a new image of a purple flower",
      }),
    });
    assert.equal(create.response.status, 200);
    assert.equal(create.body.mode, "image-generation");
    assert.equal(create.body.model, "test-model.safetensors");
    const workflows = calls.filter(({ url }) => url.endsWith("/prompt")).map(({ options }) => JSON.parse(options.body).prompt);
    assert.equal(workflows[1]["6"].class_type, "EmptyLatentImage");
    assert.equal(workflows[1]["5"].inputs.denoise, 1);
    assert.equal(workflows.length, 2);

    const history = await request(`/ai/conversations/${create.body.conversationId}/messages`, { cookie: adminCookie });
    const assistants = history.body.messages.filter((message) => message.role === "assistant" && message.mode === "image-generation");
    assert.equal(assistants.length, 2);
    assert.equal(assistants.at(-1).attachments[0].mimeType, "image/png");
    const savedImage = await request(`/ai/attachments/${assistants.at(-1).attachments[0].id}`, { cookie: adminCookie });
    assert.equal(savedImage.response.status, 200);
    assert.equal(savedImage.body, generatedPng.toString());
  } finally {
    globalThis.fetch = originalFetch;
    if (originalComfyUrl === undefined) delete process.env.COMFYUI_URL;
    else process.env.COMFYUI_URL = originalComfyUrl;
    if (originalComfyCheckpoint === undefined) delete process.env.COMFYUI_CHECKPOINT;
    else process.env.COMFYUI_CHECKPOINT = originalComfyCheckpoint;
  }
});

test("Copilot conversations and private file attachments survive API reloads", async () => {
  const created = await request("/ai/conversations", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({}),
  });
  assert.equal(created.response.status, 201);
  const conversationId = created.body.conversation.id;
  const fileContents = "Employee handbook excerpt";
  const sent = await request("/ai/chat", {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({
      conversationId,
      question: "Summarize this file",
      attachments: [{
        name: "handbook.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from(fileContents).toString("base64"),
      }],
    }),
  });
  assert.equal(sent.response.status, 409);
  assert.equal(sent.body.conversationId, conversationId);

  const history = await request(`/ai/conversations/${conversationId}/messages`, { cookie: adminCookie });
  assert.equal(history.response.status, 200);
  assert.equal(history.body.messages.length, 2);
  assert.equal(history.body.messages[0].text, "Summarize this file");
  assert.equal(history.body.messages[0].attachments[0].name, "handbook.txt");
  const fileId = history.body.messages[0].attachments[0].id;
  const downloaded = await request(`/ai/attachments/${fileId}`, { cookie: adminCookie });
  assert.equal(downloaded.response.status, 200);
  assert.equal(downloaded.body, fileContents);

  const otherUserHistory = await request(`/ai/conversations/${conversationId}/messages`, { cookie: employeeCookie });
  assert.equal(otherUserHistory.response.status, 404);
  const removed = await request(`/ai/conversations/${conversationId}`, {
    method: "DELETE",
    cookie: adminCookie,
  });
  assert.equal(removed.response.status, 204);
  const removedFile = await request(`/ai/attachments/${fileId}`, { cookie: adminCookie });
  assert.equal(removedFile.response.status, 404);
});

test("Copilot receives file attachments and recent conversation context without tools", async () => {
  const originalStart = copilotClient.start;
  const originalCreateSession = copilotClient.createSession;
  const adminId = db.prepare("SELECT id FROM users WHERE email = ?").get("sana@example.com").id;
  db.prepare("UPDATE users SET copilot_access_token = ?, copilot_github_sub = ? WHERE id = ?")
    .run(encryptCopilotAccessToken("gho-upload-test-token"), "copilot-upload-user", adminId);
  let attachedPath;
  let submittedPrompt;
  let lastAttachedNames = [];
  let turn = 0;
  copilotClient.start = async () => {};
  copilotClient.createSession = async (config) => {
    assert.deepEqual(config.availableTools, []);
    return {
      sendAndWait: async ({ prompt, attachments = [] }) => {
        submittedPrompt = prompt;
        lastAttachedNames = attachments.map((attachment) => attachment.displayName);
        if (attachments.length) {
          attachedPath = attachments[0].path;
          assert.equal((await readFile(attachedPath)).toString(), "private notes");
        }
        turn += 1;
        return { data: { content: `answer ${turn}` } };
      },
      on: () => () => {},
      disconnect: async () => {},
    };
  };
  try {
    const first = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({ question: "Remember this detail" }),
    });
    assert.equal(first.response.status, 200);
    const second = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({
        conversationId: first.body.conversationId,
        question: "Summarize my notes",
        attachments: [{
          name: "notes.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("private notes").toString("base64"),
        }],
      }),
    });
    assert.equal(second.response.status, 200);
    const followUp = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({
        conversationId: first.body.conversationId,
        question: "What was the main point in my file?",
      }),
    });
    assert.equal(followUp.response.status, 200);
    assert.match(submittedPrompt, /Summarize my notes/);
    assert.match(submittedPrompt, /answer 2/);
    assert.deepEqual(lastAttachedNames, ["notes.txt"]);
    assert.ok(attachedPath);
    await assert.rejects(readFile(attachedPath));
  } finally {
    copilotClient.start = originalStart;
    copilotClient.createSession = originalCreateSession;
    db.prepare("UPDATE users SET copilot_access_token = NULL, copilot_github_sub = NULL WHERE id = ?").run(adminId);
  }
});

test("Copilot-returned image artifacts are saved as assistant chat attachments", async () => {
  const originalStart = copilotClient.start;
  const originalCreateSession = copilotClient.createSession;
  const adminId = db.prepare("SELECT id FROM users WHERE email = ?").get("sana@example.com").id;
  db.prepare("UPDATE users SET copilot_access_token = ?, copilot_github_sub = ? WHERE id = ?")
    .run(encryptCopilotAccessToken("gho-image-generation-token"), "copilot-image-user", adminId);
  const png = Buffer.from("test-generated-image-bytes");
  copilotClient.start = async () => {};
  copilotClient.createSession = async (config) => {
    assert.equal(config.imageGeneration.enabled, true);
    return {
      on: (eventName, handler) => {
        assert.equal(eventName, "tool.execution_complete");
        queueMicrotask(() => handler({
          data: {
            result: {
              contents: [{
                type: "image",
                mimeType: "image/png",
                data: png.toString("base64"),
              }],
            },
          },
        }));
        return () => {};
      },
      sendAndWait: async () => ({ data: { content: "I edited your image." } }),
      disconnect: async () => {},
    };
  };
  try {
    const response = await request("/ai/chat", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({ question: "How many people are on the team?" }),
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.body.images.length, 1);
    const history = await request(`/ai/conversations/${response.body.conversationId}/messages`, { cookie: adminCookie });
    const assistantMessage = history.body.messages.at(-1);
    assert.equal(assistantMessage.attachments[0].mimeType, "image/png");
    const image = await request(`/ai/attachments/${assistantMessage.attachments[0].id}`, { cookie: adminCookie });
    assert.equal(image.response.status, 200);
    assert.equal(image.body, png.toString());
  } finally {
    copilotClient.start = originalStart;
    copilotClient.createSession = originalCreateSession;
    db.prepare("UPDATE users SET copilot_access_token = NULL, copilot_github_sub = NULL WHERE id = ?").run(adminId);
  }
});

test("cross-origin browser requests are rejected before session actions", async () => {
  const response = await request("/auth/logout", {
    method: "POST",
    cookie: adminCookie,
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(response.response.status, 403);
});

test("Cloudflare Quick Tunnel requests are accepted only for the matching forwarded public host", async () => {
  process.env.NODE_ENV = "development";
  const requestWithHost = (origin, host, forwardedHost) => new Promise((resolve, reject) => {
    const headers = { Origin: origin, Host: host, Cookie: adminCookie };
    if (forwardedHost) headers["X-Hcm-Public-Host"] = forwardedHost;
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/api/auth/logout",
      method: "POST",
      headers,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  assert.equal(await requestWithHost("https://hcm-preview.trycloudflare.com", "hcm-preview.trycloudflare.com"), 204);
  assert.equal(await requestWithHost("https://another-preview.trycloudflare.com", "hcm-preview.trycloudflare.com"), 403);
  assert.equal(await requestWithHost("https://hcm-preview.trycloudflare.com", "127.0.0.1:3001", "hcm-preview.trycloudflare.com"), 204);
  assert.equal(await requestWithHost("https://another-preview.trycloudflare.com", "127.0.0.1:3001", "hcm-preview.trycloudflare.com"), 403);
  process.env.NODE_ENV = "test";
});
