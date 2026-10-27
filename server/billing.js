import { randomBytes } from "node:crypto";
import { db } from "./db.js";

export const BILLING_START_DATE = "2026-11-21";

export function karachiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function currentBillingMonth(now = new Date()) {
  const { year, month } = karachiDate(now);
  return `${year}-${month}`;
}

export function isMonthlyPaymentRequired(now = new Date()) {
  const today = karachiDate(now);
  const todayString = `${today.year}-${today.month}-${today.day}`;
  return todayString >= BILLING_START_DATE && Number(today.day) > 20;
}

export function hasCurrentMonthPayment(userId, now = new Date()) {
  if (!isMonthlyPaymentRequired(now)) return true;
  return Boolean(db.prepare(`
    SELECT 1 FROM monthly_payments
    WHERE user_id = ? AND billing_month = ? AND status = 'paid'
    LIMIT 1
  `).get(userId, currentBillingMonth(now)));
}

export function getBillingStatus(user, now = new Date()) {
  const company = db.prepare(`
    SELECT monthly_fee AS monthlyFee, easypaisa_account AS receiverAccount
    FROM companies WHERE id = 1
  `).get();
  const month = currentBillingMonth(now);
  const dueDate = `${month}-20`;
  const required = isMonthlyPaymentRequired(now);

  if (user.role === "admin") {
    return {
      month,
      dueDate,
      monthlyFee: company?.monthlyFee ?? 1000,
      receiverAccount: company?.receiverAccount || "",
      paid: true,
      required: false,
      payment: null,
      phone: user.phone || "",
      reviewQueue: db.prepare(`
        SELECT p.id, p.user_id AS userId, u.name, u.email, u.phone,
          p.billing_month AS billingMonth, p.amount, p.receiver_account AS receiverAccount,
          p.transaction_reference AS transactionReference, p.status,
          p.expires_at AS expiresAt, p.submitted_at AS submittedAt,
          p.created_at AS createdAt
        FROM monthly_payments p JOIN users u ON u.id = p.user_id
        WHERE p.status IN ('submitted', 'rejected')
        ORDER BY p.submitted_at DESC, p.created_at DESC, p.rowid DESC LIMIT 100
      `).all(),
    };
  }

  const paidPayment = db.prepare(`
    SELECT id, billing_month AS billingMonth, amount,
      receiver_account AS receiverAccount, status, expires_at AS expiresAt,
      transaction_reference AS transactionReference, created_at AS createdAt
    FROM monthly_payments
    WHERE user_id = ? AND billing_month = ? AND status = 'paid'
    ORDER BY verified_at DESC, rowid DESC LIMIT 1
  `).get(user.id, month);

  let payment = paidPayment || db.prepare(`
    SELECT id, billing_month AS billingMonth, amount,
      receiver_account AS receiverAccount, status, expires_at AS expiresAt,
      transaction_reference AS transactionReference, created_at AS createdAt
    FROM monthly_payments
    WHERE user_id = ? AND billing_month = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(user.id, month);

  const today = karachiDate(now);
  const todayString = `${today.year}-${today.month}-${today.day}`;
  if (payment && ["pending", "rejected"].includes(payment.status) && todayString > payment.expiresAt) {
    db.prepare("UPDATE monthly_payments SET status = 'expired' WHERE id = ? AND status IN ('pending', 'rejected')").run(payment.id);
    payment = { ...payment, status: "expired" };
  }

  return {
    month,
    dueDate,
    monthlyFee: company?.monthlyFee ?? 1000,
    receiverAccount: company?.receiverAccount || "",
    paid: !required || Boolean(paidPayment),
    required,
    payment: payment || null,
    phone: user.phone || "",
  };
}

export function createMonthlyPayment(user, now = new Date()) {
  const status = getBillingStatus(user, now);
  if (!status.required) {
    const error = new Error("Monthly payment is available after the 20th.");
    error.status = 409;
    throw error;
  }
  if (status.paid) {
    const error = new Error("This month's fee is already paid.");
    error.status = 409;
    throw error;
  }
  if (!status.receiverAccount) {
    const error = new Error("The Admin has not added an EasyPaisa receiving account yet.");
    error.status = 409;
    throw error;
  }
  if (status.payment && ["pending", "submitted"].includes(status.payment.status)) {
    return status.payment;
  }

  const today = karachiDate(now);
  const todayString = `${today.year}-${today.month}-${today.day}`;
  let expiresAt = status.dueDate;
  if (todayString > status.dueDate) {
    const renewedExpiry = new Date(`${todayString}T12:00:00.000Z`);
    renewedExpiry.setUTCDate(renewedExpiry.getUTCDate() + 7);
    expiresAt = renewedExpiry.toISOString().slice(0, 10);
  }

  const id = `EP-${status.month}-${randomBytes(4).toString("hex").toUpperCase()}`;
  db.prepare(`
    INSERT INTO monthly_payments
      (id, user_id, billing_month, amount, receiver_account, status, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, user.id, status.month, status.monthlyFee, status.receiverAccount, expiresAt);
  return db.prepare(`
    SELECT id, billing_month AS billingMonth, amount,
      receiver_account AS receiverAccount, status, expires_at AS expiresAt,
      transaction_reference AS transactionReference, created_at AS createdAt
    FROM monthly_payments WHERE id = ?
  `).get(id);
}

export function submitMonthlyPayment(user, paymentId, transactionReference) {
  const payment = db.prepare(`
    SELECT id, status, expires_at AS expiresAt
    FROM monthly_payments WHERE id = ? AND user_id = ? AND billing_month = ?
  `).get(paymentId, user.id, currentBillingMonth());
  if (!payment) {
    const error = new Error("That monthly payment request could not be found.");
    error.status = 404;
    throw error;
  }
  const today = karachiDate();
  const todayString = `${today.year}-${today.month}-${today.day}`;
  if (["pending", "rejected"].includes(payment.status) && todayString > payment.expiresAt) {
    db.prepare("UPDATE monthly_payments SET status = 'expired' WHERE id = ? AND status IN ('pending', 'rejected')").run(payment.id);
    payment.status = "expired";
  }
  if (!["pending", "rejected"].includes(payment.status)) {
    const error = new Error(payment.status === "paid"
      ? "This payment has already been approved."
      : "This payment request expired. Generate a new payment ID to continue.");
    error.status = 409;
    throw error;
  }
  try {
    db.prepare(`
      UPDATE monthly_payments
      SET transaction_reference = ?, status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
        verified_by = NULL, verified_at = NULL
      WHERE id = ?
    `).run(transactionReference, payment.id);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.errcode === 2067) {
      const duplicate = new Error("This EasyPaisa transaction reference was already submitted.");
      duplicate.status = 409;
      throw duplicate;
    }
    throw error;
  }
  return db.prepare(`
    SELECT id, billing_month AS billingMonth, amount,
      receiver_account AS receiverAccount, status, expires_at AS expiresAt,
      transaction_reference AS transactionReference, created_at AS createdAt
    FROM monthly_payments WHERE id = ?
  `).get(payment.id);
}
