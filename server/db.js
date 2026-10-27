import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = resolve(projectDirectory, process.env.DATABASE_PATH || "data/hcm-lite.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    office_start TEXT NOT NULL DEFAULT '09:00',
    grace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (grace_minutes BETWEEN 0 AND 120),
    weekend TEXT NOT NULL DEFAULT 'Saturday & Sunday',
    office_latitude REAL,
    office_longitude REAL,
    office_radius_meters INTEGER NOT NULL DEFAULT 150 CHECK (office_radius_meters BETWEEN 25 AND 5000),
    easypaisa_account TEXT,
    monthly_fee INTEGER NOT NULL DEFAULT 1000 CHECK (monthly_fee BETWEEN 1 AND 1000000)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'hr', 'employee')),
    employee_id TEXT,
    phone TEXT,
    address TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    department TEXT NOT NULL,
    title TEXT NOT NULL,
    salary INTEGER NOT NULL CHECK (salary > 0),
    joined_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive', 'Probation'))
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    work_date TEXT NOT NULL,
    check_in TEXT NOT NULL,
    check_out TEXT,
    status TEXT NOT NULL CHECK (status IN ('Present', 'Late', 'Half day', 'Pending')),
    UNIQUE (employee_id, work_date)
  );

  CREATE TABLE IF NOT EXISTS attendance_corrections (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    work_date TEXT NOT NULL,
    requested_check_in TEXT,
    requested_check_out TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Declined')),
    reviewer_id TEXT REFERENCES users(id),
    review_comment TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    type TEXT NOT NULL CHECK (type IN ('Annual', 'Sick', 'Casual', 'Unpaid')),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days INTEGER NOT NULL CHECK (days > 0),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Declined')),
    reviewer_id TEXT REFERENCES users(id),
    review_comment TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS leave_types (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    annual_quota INTEGER,
    paid INTEGER NOT NULL DEFAULT 1 CHECK (paid IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payroll_runs (
    id TEXT PRIMARY KEY,
    month TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('Draft', 'Finalized')),
    created_by TEXT NOT NULL REFERENCES users(id),
    finalized_by TEXT REFERENCES users(id),
    finalized_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payslips (
    id TEXT PRIMARY KEY,
    payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id),
    employee_id TEXT NOT NULL REFERENCES employees(id),
    basic INTEGER NOT NULL,
    gross INTEGER NOT NULL,
    deductions INTEGER NOT NULL,
    tax INTEGER NOT NULL,
    net INTEGER NOT NULL,
    UNIQUE (payroll_run_id, employee_id)
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    question TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New conversation',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'copilot',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS monthly_payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    billing_month TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    receiver_account TEXT NOT NULL,
    transaction_reference TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'paid', 'rejected', 'expired')),
    expires_at TEXT NOT NULL,
    submitted_at TEXT,
    verified_by TEXT REFERENCES users(id),
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_monthly_payments_user_month
    ON monthly_payments(user_id, billing_month, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_monthly_payments_status
    ON monthly_payments(status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_attendance_employee_date
    ON attendance(employee_id, work_date);
  CREATE INDEX IF NOT EXISTS idx_leave_employee_status
    ON leave_requests(employee_id, status);
  CREATE INDEX IF NOT EXISTS idx_audit_created_at
    ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_corrections_status
    ON attendance_corrections(status, work_date);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_date
    ON notifications(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_updated
    ON ai_conversations(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
    ON ai_messages(conversation_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_ai_attachments_message
    ON ai_attachments(message_id);
`);

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

ensureColumn("companies", "office_latitude", "REAL");
ensureColumn("companies", "office_longitude", "REAL");
ensureColumn("companies", "office_radius_meters", "INTEGER NOT NULL DEFAULT 150");
ensureColumn("companies", "easypaisa_account", "TEXT");
ensureColumn("companies", "monthly_fee", "INTEGER NOT NULL DEFAULT 1000");
ensureColumn("users", "phone", "TEXT");
ensureColumn("users", "address", "TEXT");
ensureColumn("users", "signup_code_hash", "TEXT");
ensureColumn("users", "signup_code_expires_at", "TEXT");
ensureColumn("users", "google_sub", "TEXT");
ensureColumn("users", "github_sub", "TEXT");
ensureColumn("users", "copilot_access_token", "TEXT");
ensureColumn("users", "copilot_github_sub", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_sub ON users(github_sub) WHERE github_sub IS NOT NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_copilot_github_sub ON users(copilot_github_sub) WHERE copilot_github_sub IS NOT NULL");

if (db.prepare("SELECT 1 FROM companies WHERE id = 1").get()) {
  const departmentNames = db.prepare(`
    SELECT DISTINCT department AS name FROM employees
    WHERE department IS NOT NULL AND trim(department) != ''
  `).all();
  const insertDepartment = db.prepare("INSERT OR IGNORE INTO departments (id, name) VALUES (?, ?)");
  for (const department of departmentNames) {
    insertDepartment.run(randomUUID(), department.name);
  }
  if (!db.prepare("SELECT 1 FROM departments WHERE active = 1").get()) {
    insertDepartment.run(randomUUID(), "General");
  }
  const insertLeaveType = db.prepare("INSERT OR IGNORE INTO leave_types (name, annual_quota, paid) VALUES (?, ?, ?)");
  insertLeaveType.run("Annual", 14, 1);
  insertLeaveType.run("Sick", 8, 1);
  insertLeaveType.run("Casual", 10, 1);
  insertLeaveType.run("Unpaid", null, 0);
}

export function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
