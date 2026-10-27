import jwt from "jsonwebtoken";
import { hasCurrentMonthPayment } from "./billing.js";
import { db } from "./db.js";

export const COOKIE_NAME = "hcm_session";
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 12 * 60 * 60 * 1000,
};

export function createToken(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET || process.env.DEV_JWT_SECRET, {
    expiresIn: "12h",
  });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Please sign in to continue." });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET || process.env.DEV_JWT_SECRET);
  } catch {
    res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
  const user = db.prepare(`
    SELECT id, email, name, role, phone, must_change_password AS mustChangePassword, active
    FROM users WHERE id = ?
  `).get(payload.sub);
  if (!user || !user.active) return res.status(401).json({ error: "Your session is no longer active. Please sign in again." });
  req.user = user;
  if (user.mustChangePassword && !["/api/auth/me", "/api/auth/change-password", "/api/auth/logout"].includes(req.path)) {
    return res.status(403).json({ error: "Change your temporary password before continuing.", code: "PASSWORD_CHANGE_REQUIRED" });
  }
  if (user.role !== "admin" && !hasCurrentMonthPayment(user.id)
    && !["/api/auth/me", "/api/auth/logout", "/api/auth/change-password"].includes(req.path)
    && !req.path.startsWith("/api/billing/")) {
    return res.status(402).json({
      error: "Pay this month's fee to continue to your workspace.",
      code: "PAYMENT_REQUIRED",
    });
  }
  return next();
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "You do not have permission to do that." });
    return next();
  };
}

export function employeeScope(req, requestedEmployeeId) {
  if (req.user.role !== "employee") return requestedEmployeeId;
  return req.user.id;
}
