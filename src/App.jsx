import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowRight, Bell, CalendarDays, Camera, Check, CheckCheck,
  Clock3, FileText, LayoutDashboard, LoaderCircle, LogOut, Megaphone, Moon,
  Menu, MessageCircle, MessageSquarePlus, Paperclip, Plus, ScanFace, Search,
  Settings, Sparkles, Trash2, Users, Sun, WalletCards, X, XCircle,
} from "lucide-react";
import {
  averageFaceDescriptors,
  deleteFaceTemplate,
  faceDescriptorDistance,
  FACE_MATCH_THRESHOLD,
  getFaceTemplate,
  loadFaceRecognitionModels,
  saveFaceTemplate,
} from "./faceRecognition.js";

const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, roles: ["admin", "hr", "employee"] },
  { id: "employees", label: "People", icon: Users, roles: ["admin", "hr"] },
  { id: "attendance", label: "Attendance", icon: Clock3, roles: ["admin", "hr", "employee"] },
  { id: "leave", label: "Leave", icon: CalendarDays, roles: ["admin", "hr", "employee"] },
  { id: "payroll", label: "Payroll", icon: WalletCards, roles: ["admin", "hr", "employee"] },
  { id: "assistant", label: "Copilot", icon: Sparkles, roles: ["admin", "hr", "employee"] },
  { id: "announcements", label: "Announcements", icon: Megaphone, roles: ["admin", "hr", "employee"] },
  { id: "profile", label: "My profile", icon: Users, roles: ["admin", "hr", "employee"] },
  { id: "settings", label: "Settings", icon: Settings, roles: ["admin", "hr", "employee"] },
  { id: "audit", label: "Audit log", icon: FileText, roles: ["admin"] },
];
const getStoredPage = (identity) => {
  try {
    const saved = localStorage.getItem(`hcm-page-${identity.id}`);
    return navigation.some((item) => item.id === saved && item.roles.includes(identity.role))
      ? saved
      : "overview";
  } catch {
    return "overview";
  }
};
const encodeFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result || "");
    const separator = result.indexOf(",");
    if (separator < 0) reject(new Error(`Could not read ${file.name}.`));
    else resolve({
      name: file.name,
      mimeType: file.type,
      contentBase64: result.slice(separator + 1),
    });
  };
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader.readAsDataURL(file);
});

const titles = {
  overview: ["A little overview", "Here’s the shape of your workday."],
  employees: ["Your people", "Good teams start with knowing each other."],
  attendance: ["Showing up, together", "A clear picture of everyone’s workday."],
  leave: ["Time to recharge", "Leave that works for real life."],
  payroll: ["Payday, made clearer", "A simpler way to make every payday count."],
  assistant: ["Ask your people Copilot", "Useful answers, grounded in your workspace."],
  announcements: ["The little things, shared", "Company notes and updates, all in one place."],
  profile: ["Your profile", "Keep your work details up to date."],
  settings: ["A workspace that fits", "The small details that make your company yours."],
  audit: ["A clear trail of decisions", "A transparent record of important workspace changes."],
};

const avatarColors = ["green", "blue", "rose", "amber"];
const initials = (name = "") => name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
const dateLabel = (value) => {
  if (!value) return "—";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
};
const money = (value, compact = false) => new Intl.NumberFormat("en-PK", {
  style: "currency", currency: "PKR", maximumFractionDigits: 0,
  ...(compact ? { notation: "compact" } : {}),
}).format(value || 0);
const monthNow = () => new Date().toISOString().slice(0, 7);
const isOfficeKioskOrigin = () => ["localhost", "127.0.0.1"].includes(window.location.hostname);
const todayInKarachi = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "Something went wrong. Please try again.");
    error.status = response.status;
    error.code = result.code;
    throw error;
  }
  return result;
}

function IconBrand({ light = false }) {
  return <a className={`brand ${light ? "brand-light" : ""}`} href="#home" aria-label="HCM Lite home">
    <span className="brand-mark"><span className="brand-spark">✳</span></span>
    <span>HCM</span>
  </a>;
}

function Field({ label, className = "", hint, ...props }) {
  const id = props.id || props.name;
  return <div className="form-group">
    {label && <label className="form-label" htmlFor={id}>{label}</label>}
    <input className={`field ${className}`} {...props} id={id} />
    {hint && <p className="form-hint">{hint}</p>}
  </div>;
}

function ThemeToggle({ darkMode, onToggle }) {
  return <button className="theme-toggle" type="button" onClick={onToggle} aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"} aria-pressed={darkMode} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}>{darkMode ? <Sun size={15} /> : <Moon size={15} />}<span>{darkMode ? "Light mode" : "Dark mode"}</span></button>;
}

function GoogleSignInButton({ darkMode, onCredential, onUnavailable }) {
  const buttonRef = useRef(null);
  const callbacksRef = useRef({ onCredential, onUnavailable });
  const [nonceVersion, setNonceVersion] = useState(0);
  const [statusMessage, setStatusMessage] = useState("Checking Google sign-in setup…");

  useEffect(() => {
    callbacksRef.current = { onCredential, onUnavailable };
  }, [onCredential, onUnavailable]);

  useEffect(() => {
    let active = true;
    let script;

    const initialize = async () => {
      try {
        const config = await api("/auth/google/config");
        if (!active) return;
        if (!config.enabled) {
          setStatusMessage("Google sign-in needs a valid Web Client ID ending in .apps.googleusercontent.com. Check GOOGLE_CLIENT_ID in .env, then restart the API.");
          return;
        }

        if (!window.google?.accounts?.id) {
          script = document.createElement("script");
          script.src = "https://accounts.google.com/gsi/client";
          script.async = true;
          script.defer = true;
          await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = () => reject(new Error("Google sign-in could not load. Check your internet connection."));
            document.head.appendChild(script);
          });
        }
        if (!active || !window.google?.accounts?.id) return;
        const nonce = (await api("/auth/google/nonce")).nonce;
        window.google.accounts.id.initialize({
          client_id: config.clientId,
          nonce,
          callback: async (response) => {
            if (!active) return;
            const succeeded = await callbacksRef.current.onCredential(response.credential, nonce);
            if (!succeeded && active) setNonceVersion((version) => version + 1);
          },
          ux_mode: "popup",
          auto_select: false,
        });
        buttonRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: darkMode ? "filled_black" : "outline",
          size: "large",
          shape: "pill",
          text: "continue_with",
          width: Math.min(340, buttonRef.current?.parentElement?.clientWidth || 340),
        });
      } catch (error) {
        if (active) {
          setStatusMessage(error.message);
          callbacksRef.current.onUnavailable(error.message);
        }
      }
    };

    void initialize();
    return () => {
      active = false;
    };
  }, [darkMode, nonceVersion]);

  return <div className="google-signin-wrap"><div ref={buttonRef} className="google-signin-button" /></div>;
}

function Welcome({ setup, busy, darkMode, onToggleTheme, onSubmit, onGoogleSignIn }) {
  const [mode, setMode] = useState(setup ? "setup" : "login");
  const [signupRole, setSignupRole] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPhone, setSignupPhone] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [faceConsent, setFaceConsent] = useState(false);
  const [faceDescriptor, setFaceDescriptor] = useState(null);
  const [faceEnrollmentOpen, setFaceEnrollmentOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setMode(setup ? "setup" : "login");
  }, [setup]);

  const submit = async (event) => {
    event.preventDefault();
    if (isSignup && signupRole === "admin") {
      setError("Admin accounts can only be created during the initial company setup.");
      return;
    }
    if (isSignup && !signupRole) {
      setError("Choose whether you’re signing up as HR or Employee.");
      return;
    }
    const form = event.currentTarget;
    if (isSignup && !signupPhone.trim()) {
      setError("Add your mobile number before you sign up.");
      return;
    }
    if (isSignup && signupRole === "employee" && (!isOfficeKioskOrigin() || !faceConsent || !faceDescriptor)) {
      setError("Use the office kiosk at http://localhost:3000, give consent, and enroll your face before employee sign-up.");
      return;
    }
    if (!form.reportValidity()) return;
    if (isSignup && form.elements.password.value !== form.elements.confirmPassword.value) {
      setError("Your passwords don’t match.");
      return;
    }
    setError("");
    const values = {
      ...Object.fromEntries(new FormData(form)),
      ...(isSignup ? { role: signupRole } : {}),
      ...(isSignup && signupRole === "employee" ? { faceDescriptor } : {}),
    };
    delete values.confirmPassword;
    try {
      await onSubmit(values, mode);
    } catch (cause) {
      setError(cause.message);
    }
  };

  const isSetup = mode === "setup";
  const isSignup = mode === "signup";
  const isAdminSignup = isSignup && signupRole === "admin";
  const handleGoogleCredential = useCallback(async (credential, nonce) => {

    setError("");
    try {
      await onGoogleSignIn({
        credential,
        nonce,
        ...(isSignup ? { role: signupRole, email: signupEmail.trim(), phone: signupPhone.trim(), signupCode: signupCode.trim() } : {}),
      });
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
    }
  }, [isSignup, onGoogleSignIn, signupCode, signupEmail, signupPhone, signupRole]);
  const modeOptions = setup
    ? [{ id: "login", label: "Sign in" }, { id: "setup", label: "Create workspace" }]
    : [{ id: "login", label: "Sign in" }, { id: "signup", label: "Sign up" }];

  return <main className="onboarding">
    <section className="welcome-panel">
      <IconBrand light />
      <div className="welcome-copy">
        <span className="eyebrow eyebrow-light"><span className="online-dot" /> PEOPLE, IN GOOD HANDS</span>
        <h1>Good work<br />starts with<br /><em>good people.</em></h1>
        <p>One calmer place for your people, your everyday HR, and the little details that make work work.</p>
      </div>
      <div className="welcome-footer">Saylani Hackathon · Human Capital Management, made lighter</div>
    </section>
    <section className="setup-panel">
      <div className="theme-control-row"><ThemeToggle darkMode={darkMode} onToggle={onToggleTheme} /></div>
      <div className="mode-switch" role="tablist" aria-label="Account access">
        {modeOptions.map((option) => <button key={option.id} type="button" role="tab" aria-selected={mode === option.id} className={`mode-toggle ${mode === option.id ? "active" : ""}`} onClick={() => { setMode(option.id); setError(""); }}>{option.label}</button>)}
      </div>
      <span className="eyebrow eyebrow-dark">{isSetup ? "YOUR PEOPLE WORKSPACE" : isSignup ? "JOIN YOUR WORKSPACE" : "WELCOME BACK"}</span>
      <h2>{isSetup ? "Let’s make room for people." : isSignup ? "Your place on the team." : "Good to have you back."}</h2>
      <p>{isSetup
        ? "Start with an empty workspace. Create your company and the first administrator account to get started."
        : isSignup
          ? "Choose the role from your invite and set up your sign-in details."
        : "This workspace is already set up. Sign in with the administrator account created during setup. HR and employee accounts are created inside the workspace."}</p>

      {isSetup && <div className="role-overview-grid">
        {[
          { label: "As an Admin", detail: "Full company visibility — sees every employee, attendance, leave and payroll record." },
          { label: "As an HR", detail: "People operations access — limited company data, payroll drafts and leave review." },
          { label: "As an Employee", detail: "Self-service only — own profile, attendance, leave and payslips." },
        ].map((item) => (
          <div key={item.label} className="role-card">
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </div>
        ))}
      </div>}

      {isSignup && <fieldset className="signup-role-picker">
        <legend>Sign up as</legend>
        {[
          { id: "admin", label: "Admin", detail: "Company owner and full workspace access" },
          { id: "hr", label: "HR", detail: "People operations with an Admin invite" },
          { id: "employee", label: "Employee", detail: "Personal self-service with an invite" },
        ].map((option) => <label key={option.id} className={`signup-role-option ${signupRole === option.id ? "selected" : ""}`}>
          <input type="radio" name="signupRole" value={option.id} checked={signupRole === option.id} onChange={() => { setSignupRole(option.id); setFaceConsent(false); setFaceDescriptor(null); setError(""); }} />
          <span><strong>{option.label}</strong><small>{option.detail}</small></span>
        </label>)}
        {isAdminSignup && <p className="signup-role-note" role="status">An Admin account is created when the company workspace is first set up. For an existing workspace, ask its Admin to create your account.</p>}
      </fieldset>}

      <form onSubmit={submit}>
        {isSetup && <>
          <Field label="Company name" id="company" name="company" placeholder="e.g. Goodwork Studio" required minLength={2} maxLength={80} />
          <div className="form-grid">
            <Field label="Your name" id="name" name="name" placeholder="e.g. Sana Ahmed" required minLength={2} maxLength={80} />
            <Field label="Work email" id="email" name="email" type="email" placeholder="you@company.com" required />
          </div>
        </>}
        {!isSetup && !isAdminSignup && <Field label={isSignup ? "Invited work email" : "Work email"} id="email" name="email" type="email" autoComplete="username" placeholder="you@company.com" required value={signupEmail} onChange={(event) => setSignupEmail(event.target.value)} />}
        {isSignup && !isAdminSignup && <Field label="Mobile number (required)" id="signupPhone" name="phone" type="tel" autoComplete="tel" placeholder="+92 300 1234567" required value={signupPhone} onChange={(event) => setSignupPhone(event.target.value)} onInvalid={() => setError("Add your mobile number before you sign up.")} hint="Needed for your monthly EasyPaisa payment." />}
        {isSignup && !isAdminSignup && <Field label="Invite code" id="signupCode" name="signupCode" autoComplete="one-time-code" placeholder="Paste the code from your Admin/HR" required minLength={20} maxLength={100} value={signupCode} onChange={(event) => setSignupCode(event.target.value)} />}
        {isSignup && signupRole === "employee" && <div className="face-enrollment-box">
          <label className="camera-manual-check"><input type="checkbox" checked={faceConsent} onChange={(event) => { setFaceConsent(event.target.checked); if (!event.target.checked) setFaceDescriptor(null); }} /> I consent to local face-template processing on this office kiosk for attendance matching.</label>
          <p className="form-hint">{isOfficeKioskOrigin()
            ? "Only a mathematical face template is stored in this browser's IndexedDB. Camera images are not saved or uploaded. This app does not encrypt the template; restrict access to this browser profile. Complete signup and future check-ins on this kiosk. Face matching is not liveness detection and may be fooled by a photo."
            : "Employee face enrollment must be done on the office kiosk at http://localhost:3000. Temporary Cloudflare links and other devices have separate local storage."}</p>
          <button className="secondary-btn" type="button" disabled={!faceConsent || !isOfficeKioskOrigin()} onClick={() => setFaceEnrollmentOpen(true)}><ScanFace size={15} /> {faceDescriptor ? "Retake face samples" : "Enroll face on this kiosk"}</button>
          {faceDescriptor && <span className="face-enrollment-status" role="status"><Check size={14} /> Three face samples captured on this device.</span>}
        </div>}
        {!isAdminSignup && <Field label={isSignup ? "Create password" : "Password"} id="password" name="password" type="password" autoComplete={isSetup || isSignup ? "new-password" : "current-password"} minLength={isSetup || isSignup ? 12 : 1} maxLength={128} placeholder={isSetup || isSignup ? "At least 12 characters" : "Your password"} required hint={isSetup || isSignup ? "Use at least 12 characters." : undefined} />}
        {isSignup && !isAdminSignup && <Field label="Confirm password" id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} placeholder="Enter the password again" required />}
        {error && <div className="form-error" role="alert">{error}</div>}
        {!isAdminSignup && <button className="primary-btn full-width" type="submit" disabled={busy}>
          {busy ? <><LoaderCircle className="spin" size={16} /> {isSetup ? "Making your workspace…" : isSignup ? "Creating your account…" : "Signing in…"}</> : <>{isSetup ? "Create my workspace" : isSignup ? "Create account" : "Sign in"} <ArrowRight size={15} /></>}
        </button>
        }
      </form>
      {!isSetup && !isSignup && <div className="google-auth-option">
        <div className="divider"><span>OR</span></div>
        <GoogleSignInButton
          darkMode={darkMode}
          onUnavailable={setError}
          onCredential={handleGoogleCredential}
        />
      </div>}
      <p className="privacy-note">{isSignup ? "Invites are role-specific, expire after 7 days, and can be used once." : "Your workspace lives in a persistent database. Sign-in uses a secure, HTTP-only session cookie."}</p>
    </section>
    {faceEnrollmentOpen && <FaceCameraModal
      mode="enroll"
      name="your employee account"
      busy={busy}
      onEnroll={async (descriptor) => { setFaceDescriptor(descriptor); }}
      onConfirm={async () => {}}
      onClose={() => setFaceEnrollmentOpen(false)}
    />}
  </main>;
}

function BillingScreen({ user, billing, busy, darkMode, onToggleTheme, onSavePhone, onCreatePayment, onSubmitPayment, onLogout }) {
  const [phone, setPhone] = useState(billing.phone || "");
  const [transactionReference, setTransactionReference] = useState("");
  const [clock, setClock] = useState(Date.now());
  const payment = billing.payment;
  const today = todayInKarachi(new Date(clock));
  const paymentExpired = payment && (payment.status === "expired"
    || (["pending", "rejected"].includes(payment.status) && today > payment.expiresAt));
  const canSubmitReference = payment && !paymentExpired && ["pending", "rejected"].includes(payment.status);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  return <main className="billing-screen">
    <section className="setup-panel billing-panel">
      <div className="theme-control-row"><ThemeToggle darkMode={darkMode} onToggle={onToggleTheme} /></div>
      <IconBrand />
      <span className="eyebrow eyebrow-dark">MONTHLY WORKSPACE ACCESS</span>
      <h2>This month’s EasyPaisa fee</h2>
      <p>Hello {user.name.split(" ")[0]}, pay the monthly fee to unlock your HR workspace features.</p>
      <div className="billing-price"><strong>PKR {Number(billing.monthlyFee).toLocaleString("en-PK")}</strong><span>{billing.month} · payable after the 20th</span></div>

      {!billing.phone && <form className="billing-phone-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!event.currentTarget.reportValidity()) return;
        try {
          await onSavePhone(phone.trim());
        } catch {
          // The shared error toast explains a failed save.
        }
      }}>
        <Field label="Mobile number (required for payment)" name="phone" type="tel" autoComplete="tel" placeholder="+92 300 1234567" required value={phone} onChange={(event) => setPhone(event.target.value)} />
        <button className="primary-btn full-width" type="submit" disabled={busy}>{busy ? "Saving…" : "Save mobile number"}</button>
      </form>}

      {billing.phone && <>
        {!payment && <button className="primary-btn full-width billing-main-action" type="button" disabled={busy || !billing.receiverAccount} onClick={() => void onCreatePayment().catch(() => {})}>
          <WalletCards size={16} /> {busy ? "Creating payment ID…" : "Get this month’s payment ID"}
        </button>}
        {payment && <div className="payment-instructions">
          {paymentExpired && <div className="form-error" role="status">This payment ID expired. Generate a fresh ID to continue. Renewed IDs are valid for 7 days.</div>}
          {payment.status === "rejected" && <div className="form-error" role="status">The Admin could not verify that transfer. Check your transaction reference and submit it again.</div>}
          {payment.status === "submitted" && <div className="billing-pending" role="status"><Clock3 size={17} /><span>Payment submitted. Your workspace unlocks after the Admin verifies the EasyPaisa transaction.</span></div>}
          {!paymentExpired && <div className="payment-id-row"><span>Payment ID</span><strong>{payment.id}</strong></div>}
          {!paymentExpired && <div className="payment-id-row"><span>Send PKR {Number(payment.amount).toLocaleString("en-PK")} to</span><strong>{payment.receiverAccount}</strong></div>}
          {!paymentExpired && <p className="payment-expiry">Valid until {payment.expiresAt}. Keep your EasyPaisa transaction reference.</p>}
          {canSubmitReference && <form onSubmit={async (event) => {
            event.preventDefault();
            if (!event.currentTarget.reportValidity()) return;
            try {
              await onSubmitPayment(payment.id, transactionReference.trim());
              setTransactionReference("");
            } catch {
              // The shared error toast explains a failed submission.
            }
          }}>
            <Field label="EasyPaisa transaction/reference number" name="transactionReference" required minLength={5} maxLength={100} placeholder="Enter the reference from your receipt" value={transactionReference} onChange={(event) => setTransactionReference(event.target.value)} />
            <button className="primary-btn full-width" type="submit" disabled={busy}>{busy ? "Submitting…" : "I’ve paid — submit for verification"}</button>
          </form>}
          {paymentExpired && <button className="primary-btn full-width billing-main-action" type="button" disabled={busy} onClick={() => void onCreatePayment().catch(() => {})}>
            <WalletCards size={16} /> {busy ? "Generating a fresh ID…" : "Generate a new payment ID"}
          </button>}
        </div>}
      </>}

      {!billing.receiverAccount && <p className="billing-unavailable" role="status">The Admin needs to add the EasyPaisa receiving account in Settings before payment can start.</p>}
      <p className="billing-footnote">Payments are checked manually by your Admin. Don’t share your EasyPaisa PIN or OTP. Need help? Contact your workspace Admin.</p>
      <button className="ghost-btn billing-signout" type="button" disabled={busy} onClick={onLogout}>Sign out</button>
    </section>
  </main>;
}

function BillingLoadError({ message, busy, darkMode, onToggleTheme, onRetry, onLogout }) {
  return <main className="billing-screen">
    <section className="setup-panel billing-panel">
      <div className="theme-control-row"><ThemeToggle darkMode={darkMode} onToggle={onToggleTheme} /></div>
      <IconBrand />
      <span className="eyebrow eyebrow-dark">MONTHLY ACCESS</span>
      <h2>Couldn’t check your monthly access.</h2>
      <p>{message || "The server did not return your billing status. Check your connection and try again."}</p>
      <div className="modal-actions">
        <button className="secondary-btn" type="button" disabled={busy} onClick={onLogout}>Sign out</button>
        <button className="primary-btn" type="button" disabled={busy} onClick={onRetry}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}
          {busy ? "Checking…" : "Try again"}
        </button>
      </div>
    </section>
  </main>;
}

function PasswordChangeScreen({ busy, darkMode, onToggleTheme, onSubmit }) {
  const [error, setError] = useState("");
  return <main className="password-screen">
    <section className="setup-panel password-screen-panel">
      <div className="theme-control-row"><ThemeToggle darkMode={darkMode} onToggle={onToggleTheme} /></div>
      <IconBrand />
      <span className="eyebrow eyebrow-dark">ACCOUNT SECURITY</span>
      <h2>Choose your own password.</h2>
      <p>Your temporary password must be replaced before you can continue into the workspace.</p>
      <form onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = Object.fromEntries(new FormData(form));
        if (values.newPassword !== values.confirmPassword) {
          setError("Your new passwords don’t match.");
          return;
        }
        setError("");
        try {
          await onSubmit({ currentPassword: values.currentPassword, newPassword: values.newPassword });
        } catch (cause) {
          setError(cause.message);
        }
      }}>
        <Field label="Temporary password" name="currentPassword" type="password" required autoComplete="current-password" />
        <Field label="New password" name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" hint="Use at least 12 characters." />
        <Field label="Confirm new password" name="confirmPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="primary-btn full-width" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={16} /> Saving…</> : <>Set my password <ArrowRight size={15} /></>}</button>
      </form>
    </section>
  </main>;
}

function Avatar({ name, index = 0, className = "" }) {
  return <span className={`avatar avatar-${avatarColors[index % avatarColors.length]} ${className}`}>{initials(name)}</span>;
}

function Status({ children, kind }) {
  const normalized = kind || String(children).toLowerCase();
  const style = normalized.includes("pending") ? "pending"
    : normalized === "late" || normalized.includes("declin") || normalized === "half day" ? "late"
      : normalized === "draft" || normalized === "neutral" ? "neutral" : "";
  return <span className={`status ${style}`}>{children}</span>;
}

function Modal({ title, subtitle, onClose, children, busy }) {
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-head"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div>
        {!busy && <button className="icon-btn" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>}
      </div>
      {children}
    </section>
  </div>;
}

function FaceCameraModal({ mode, action, name, expectedDescriptor, busy, onConfirm, onEnroll, onForget, onClose }) {
  const videoRef = useRef(null);
  const detectionInProgress = useRef(false);
  const callbacksRef = useRef({ onConfirm, onEnroll, onForget, onClose });
  const expectedDescriptorRef = useRef(expectedDescriptor);
  const latestDescriptor = useRef(null);
  const samplesRef = useRef([]);
  const matchesRef = useRef(0);
  const completedRef = useRef(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [faceDetected, setFaceDetected] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [distance, setDistance] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    callbacksRef.current = { onConfirm, onEnroll, onForget, onClose };
    expectedDescriptorRef.current = expectedDescriptor;
  }, [expectedDescriptor, onConfirm, onEnroll, onForget, onClose]);

  useEffect(() => {
    let active = true;
    let stream;
    let interval;

    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("Camera access is unavailable. Open the HCM office kiosk on localhost or HTTPS.");
        return;
      }
      try {
        const faceapi = await loadFaceRecognitionModels();
        if (!active) return;
        setModelsReady(true);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) throw new Error("The camera preview could not be opened.");
        video.srcObject = stream;
        await video.play();
        if (!active) return;
        setCameraReady(true);

        const detectFace = async () => {
          if (!active || !videoRef.current || videoRef.current.readyState < 2 || detectionInProgress.current) return;
          detectionInProgress.current = true;
          try {
            const faces = await faceapi.detectAllFaces(
              videoRef.current,
              new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }),
            ).withFaceLandmarks().withFaceDescriptors();
            if (!active) return;
            setFaceDetected(faces.length === 1);
            latestDescriptor.current = faces.length === 1 ? Array.from(faces[0].descriptor) : null;
            if (mode === "verify" && latestDescriptor.current && expectedDescriptorRef.current) {
              const currentDistance = faceDescriptorDistance(expectedDescriptorRef.current, latestDescriptor.current);
              setDistance(currentDistance);
              matchesRef.current = currentDistance <= FACE_MATCH_THRESHOLD ? matchesRef.current + 1 : 0;
              setMatchCount(matchesRef.current);
              if (matchesRef.current >= 3 && !completedRef.current) {
                completedRef.current = true;
                try {
                  await callbacksRef.current.onConfirm();
                  callbacksRef.current.onClose();
                } catch {
                  completedRef.current = false;
                  matchesRef.current = 0;
                  setMatchCount(0);
                }
              }
            } else if (mode === "verify") {
              matchesRef.current = 0;
              setMatchCount(0);
              setDistance(null);
            }
          } catch (error) {
            if (active) setCameraError(`Face matching failed. Attendance was not recorded. ${error.message}`);
            window.clearInterval(interval);
          } finally {
            detectionInProgress.current = false;
          }
        };
        interval = window.setInterval(detectFace, 900);
        void detectFace();
      } catch (error) {
        if (!active) return;
        if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
          setCameraError("Camera permission was denied. Allow camera access in your browser, then try again.");
        } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
          setCameraError("No camera was found on this device.");
        } else {
          setCameraError(error.message || "Face matching or the camera could not be started.");
        }
      }
    };

    void startCamera();
    return () => {
      active = false;
      window.clearInterval(interval);
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [mode]);

  const status = cameraError
    ? cameraError
    : !modelsReady
    ? "Loading face-matching models on this kiosk…"
    : !cameraReady
      ? "Starting your camera…"
      : !faceDetected
        ? "Show one face clearly in the camera."
        : mode === "enroll"
          ? "Face found. Capture three samples to enroll this kiosk."
          : matchCount >= 3
            ? `Face matched to ${name}. Saving attendance…`
            : distance === null
              ? "Checking this face against the kiosk enrollment…"
              : distance <= FACE_MATCH_THRESHOLD
                ? `Face match ${matchCount}/3. Hold still…`
                : "This face does not match this employee’s kiosk enrollment.";

  const captureEnrollmentSample = async () => {
    if (!latestDescriptor.current || samplesRef.current.length >= 3 || saving) return;
    const samples = [...samplesRef.current, latestDescriptor.current];
    samplesRef.current = samples;
    setSampleCount(samples.length);
    if (samples.length < 3) return;
    setSaving(true);
    try {
      await callbacksRef.current.onEnroll(averageFaceDescriptors(samples));
      callbacksRef.current.onClose();
    } catch (error) {
      samplesRef.current = [];
      setSampleCount(0);
      setCameraError(error.message || "The face template could not be saved on this kiosk.");
    } finally {
      setSaving(false);
    }
  };

  const enroll = mode === "enroll";
  const checkingOut = action === "check-out";
  return <Modal
    title={enroll ? "Enroll face on this office kiosk" : checkingOut ? "Face check for check-out" : "Face check for attendance"}
    subtitle={enroll
      ? "Three face samples create a local kiosk template. Camera frames are processed in this browser and are not uploaded. The template is not encrypted by this app."
      : "Attendance is recorded only after three consecutive matches to this signed-in employee’s local kiosk template."}
    onClose={onClose}
    busy={busy || saving}
  >
    <div className="camera-attendance">
    <div className={`camera-preview ${mode === "verify" && matchCount >= 3 ? "face-detected" : ""}`}>
      <video ref={videoRef} autoPlay muted playsInline aria-label="Live camera preview" />
      <span className="camera-guide" aria-hidden="true" />
      {(!cameraReady || !modelsReady) && !cameraError && <span className="camera-loading"><LoaderCircle className="spin" size={20} /></span>}
      <span className="camera-badge">{cameraReady && modelsReady ? <><Camera size={13} /> Local face matching ready</> : cameraError ? <><XCircle size={13} /> Camera unavailable</> : <><Camera size={13} /> Preparing kiosk</>}</span>
    </div>
    <div className={`camera-status ${mode === "verify" && matchCount >= 3 ? "ready" : cameraError ? "warning" : ""}`} role="status">
      {mode === "verify" && matchCount >= 3 ? <Check size={15} /> : <ScanFace size={15} />}
      <span>{status}</span>
    </div>
    {!enroll && <div className="camera-identity"><span className="online-dot" /><span>Checking account for <strong>{name}</strong></span></div>}
    {enroll && <div className="camera-identity"><span className="online-dot" /><span>Enrollment samples: <strong>{sampleCount}/3</strong></span></div>}
    {cameraError && <p className="camera-error" role="alert">{cameraError}</p>}
    <div className="modal-actions">
      <button className="secondary-btn" type="button" disabled={busy || saving} onClick={onClose}>Cancel</button>
      {!enroll && onForget && <button className="secondary-btn" type="button" disabled={busy || saving} onClick={async () => {
        if (!window.confirm("Remove this employee’s local face template from the office kiosk?")) return;
        try {
          await callbacksRef.current.onForget();
          callbacksRef.current.onClose();
        } catch (error) {
          setCameraError(error.message || "The local face template could not be removed.");
        }
      }}>Forget kiosk face</button>}
      {enroll && <button className="primary-btn" type="button" disabled={busy || saving || !cameraReady || !modelsReady || !faceDetected || sampleCount >= 3} onClick={() => void captureEnrollmentSample()}>
        {saving ? <LoaderCircle className="spin" size={15} /> : <ScanFace size={15} />}
        {saving ? "Saving kiosk template…" : `Capture face sample ${Math.min(sampleCount + 1, 3)}/3`}
      </button>}
    </div>
    </div>
  </Modal>;
}

function App() {
  const [checking, setChecking] = useState(true);
  const [setup, setSetup] = useState(false);
  const [user, setUser] = useState(null);
  const [data, setData] = useState(null);
  const [billing, setBilling] = useState(null);
  const [billingError, setBillingError] = useState("");
  const [summary, setSummary] = useState(null);
  const [page, setPage] = useState("overview");
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [leaveFilter, setLeaveFilter] = useState("all");
  const [messages, setMessages] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [chatAttachments, setChatAttachments] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [deleteChatTarget, setDeleteChatTarget] = useState(null);
  const [deleteChatBusy, setDeleteChatBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("hcm-theme") === "dark");
  const [cameraAttendance, setCameraAttendance] = useState(false);
  const [faceTemplate, setFaceTemplate] = useState(null);
  const [faceTemplateReady, setFaceTemplateReady] = useState(false);
  const [profile, setProfile] = useState(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [copilotConnected, setCopilotConnected] = useState(false);
  const [copilotStatusBusy, setCopilotStatusBusy] = useState(false);
  const [copilotConnecting, setCopilotConnecting] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    localStorage.setItem("hcm-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const notify = useCallback((message, kind = "success") => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3800);
  }, []);

  useEffect(() => {
    if (!user) return;
    try {
      localStorage.setItem(`hcm-page-${user.id}`, page);
    } catch {
      notify("This browser could not remember your last page.", "error");
    }
  }, [notify, page, user?.id]);

  useEffect(() => {
    if (!user) {
      setCopilotConnected(false);
      return undefined;
    }
    let active = true;
    setCopilotConnected(false);
    setCopilotStatusBusy(true);
    api("/ai/copilot/status")
      .then((result) => { if (active) setCopilotConnected(result.connected); })
      .catch((error) => { if (active) notify(error.message, "error"); })
      .finally(() => { if (active) setCopilotStatusBusy(false); });
    return () => { active = false; };
  }, [notify, user?.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("copilot_connected");
    const error = params.get("copilot_error");
    if (connected === "true") notify("Your GitHub Copilot account is connected.");
    if (error) notify(error, "error");
    if (connected || error) {
      params.delete("copilot_connected");
      params.delete("copilot_error");
      const queryString = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`);
    }
  }, [notify]);

  useEffect(() => {
    if (!user || page !== "profile") return undefined;
    let active = true;
    api("/profile")
      .then((result) => { if (active) setProfile(result.profile); })
      .catch((error) => { if (active) notify(error.message, "error"); });
    return () => { active = false; };
  }, [notify, page, user]);

  useEffect(() => {
    if (!user || page !== "assistant") return undefined;
    let active = true;
    setChatLoading(true);
    api("/ai/conversations")
      .then(async ({ conversations: savedConversations }) => {
        if (!active) return;
        setConversations(savedConversations);
        const preferredId = localStorage.getItem(`hcm-chat-${user.id}`);
        const selected = savedConversations.find((item) => item.id === preferredId) || savedConversations[0];
        if (!selected) {
          setConversationId(null);
          setMessages([]);
          return;
        }
        setConversationId(selected.id);
        const { messages: savedMessages } = await api(`/ai/conversations/${selected.id}/messages`);
        if (active) setMessages(savedMessages);
      })
      .catch((error) => { if (active) notify(error.message, "error"); })
      .finally(() => { if (active) setChatLoading(false); });
    return () => { active = false; };
  }, [notify, page, user?.id]);

  useEffect(() => {
    let active = true;
    setFaceTemplate(null);
    if (user?.role !== "employee") {
      setFaceTemplateReady(true);
      return () => { active = false; };
    }
    setFaceTemplateReady(false);
    getFaceTemplate(user.id)
      .then((record) => {
        if (active) setFaceTemplate(record?.descriptor || null);
      })
      .catch((error) => {
        if (active) notify(error.message, "error");
      })
      .finally(() => {
        if (active) setFaceTemplateReady(true);
      });
    return () => { active = false; };
  }, [notify, user?.id, user?.role]);

  const refresh = useCallback(async () => {
    setBillingError("");
    try {
      const currentBilling = await api("/billing/current");
      setBilling(currentBilling.billing);
      if (!currentBilling.billing.paid) {
        setData(null);
        setSummary(null);
        const session = await api("/auth/me");
        if (session?.user) setUser(session.user);
        return null;
      }
      const [bootstrap, dashboard] = await Promise.all([api("/bootstrap"), api("/dashboard")]);
      setUser(bootstrap.user);
      setData(bootstrap);
      setSummary(dashboard.summary);
      if (bootstrap.user.mustChangePassword) setModal({ type: "change-password", required: true });
      return bootstrap;
    } catch (error) {
      setBillingError(error.message);
      throw error;
    }
  }, []);

  useEffect(() => {
    let active = true;
    api("/setup/status")
      .then(async (status) => {
        if (!active) return;
        setSetup(!status.configured);
        if (!status.configured) return;
        const session = await api("/auth/me");
        if (session?.user) {
          setPage(getStoredPage(session.user));
          setUser(session.user);
          if (session.user.mustChangePassword) {
            setModal({ type: "change-password", required: true });
            return;
          }
          await refresh();
          if (!active) return;
        }
      })
      .catch((error) => {
        if (error.status !== 401) {
          setBillingError(error.message);
          notify(error.message, "error");
        }
      })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [notify, refresh]);

  const reload = useCallback(async () => {
    const next = await refresh();
    return next;
  }, [refresh]);

  const runAction = async (task, message, after) => {
    setBusy(true);
    try {
      const result = await task();
      if (after) await after(result);
      else await reload();
      notify(message);
      return result;
    } catch (error) {
      if (error.code === "PASSWORD_CHANGE_REQUIRED") setModal({ type: "change-password", required: true });
      notify(error.message, "error");
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const handleSetup = async (values) => {
    setBusy(true);
    try {
      await api("/setup", { method: "POST", body: JSON.stringify(values) });
      await refresh();
      setSetup(false);
      notify("Your workspace is ready. A lovely place to begin.");
    } finally { setBusy(false); }
  };

  const handleLogin = async (values) => {
    setBusy(true);
    try {
      const response = await api("/auth/login", { method: "POST", body: JSON.stringify(values) });
      setPage(getStoredPage(response.user));
      setUser(response.user);
      if (response.user.mustChangePassword) {
        setModal({ type: "change-password", required: true });
      } else {
        await refresh();
      }
      notify(`Welcome back, ${response.user.name.split(" ")[0]}.`);
    } finally { setBusy(false); }
  };

  const handleSignup = async (values) => {
    setBusy(true);
    try {
      const { faceDescriptor, ...signupValues } = values;
      const response = await api("/auth/signup", { method: "POST", body: JSON.stringify(signupValues) });
      let faceTemplateError = "";
      if (response.user.role === "employee" && faceDescriptor) {
        try {
          await saveFaceTemplate(response.user.id, faceDescriptor);
          setFaceTemplate(faceDescriptor);
        } catch (error) {
          faceTemplateError = `Your account was created, but this kiosk could not save the face template: ${error.message}`;
        }
      }
      setPage(getStoredPage(response.user));
      setUser(response.user);
      await refresh();
      if (faceTemplateError) notify(faceTemplateError, "error");
      else notify(`Welcome to the team, ${response.user.name.split(" ")[0]}.`);
    } finally { setBusy(false); }
  };

  const handleGoogleSignIn = async (values) => {
    setBusy(true);
    try {
      const response = await api("/auth/google", { method: "POST", body: JSON.stringify(values) });
      setPage(getStoredPage(response.user));
      setUser(response.user);
      if (response.user.mustChangePassword) {
        setModal({ type: "change-password", required: true });
      } else {
        await refresh();
      }
      notify(`Welcome back, ${response.user.name.split(" ")[0]}.`);
    } finally { setBusy(false); }
  };

  const logout = async () => {
    try { await api("/auth/logout", { method: "POST" }); }
    catch (error) { notify(error.message, "error"); return; }
    setUser(null); setData(null); setBilling(null); setSummary(null); setProfile(null); setFaceTemplate(null); setFaceTemplateReady(false); setPage("overview");
    setMessages([]); setConversations([]); setConversationId(null); setChatAttachments([]); setSetup(false); setModal(null);
  };

  const go = (nextPage) => {
    setPage(nextPage);
    setQuery("");
    setMenuOpen(false);
  };

  const visibleNavigation = useMemo(() => navigation.filter((item) => item.roles.includes(user?.role)), [user?.role]);

  const employeeList = data?.employees || [];
  const currentEmployee = user?.role === "employee"
    ? employeeList.find((employee) => employee.id === user.id) : null;
  const attendance = data?.attendance || [];
  const leaves = data?.leaves || [];
  const pendingCount = leaves.filter((leave) => leave.status === "Pending").length;
  const todayString = todayInKarachi();
  const myToday = attendance.find((record) => record.employeeId === user?.id && record.date === todayString);
  const attendanceAction = myToday ? (myToday.checkOut ? null : "check-out") : "check-in";
  const attendanceButtonLabel = !faceTemplateReady
    ? "Checking kiosk enrollment…"
    : !isOfficeKioskOrigin()
      ? "Use office kiosk at localhost:3000"
    : !faceTemplate
      ? "Enroll face on office kiosk"
      : attendanceAction === "check-out"
        ? "Face check out"
        : myToday?.checkOut
          ? "Checked out"
          : "Face check in";

  if (checking) return <div className="loading-screen"><LoaderCircle className="spin" size={23} /><span>Making room for people…</span></div>;
  if (!user) return <Welcome
    setup={setup}
    busy={busy}
    darkMode={darkMode}
    onToggleTheme={() => setDarkMode((enabled) => !enabled)}
    onGoogleSignIn={handleGoogleSignIn}
    onSubmit={(values, authMode) => authMode === "setup" ? handleSetup(values) : authMode === "signup" ? handleSignup(values) : handleLogin(values)}
  />;
  if (user.mustChangePassword && !data) return <PasswordChangeScreen
    busy={busy}
    darkMode={darkMode}
    onToggleTheme={() => setDarkMode((enabled) => !enabled)}
    onSubmit={async (values) => {
      setBusy(true);
      try {
        await api("/auth/change-password", { method: "POST", body: JSON.stringify(values) });
        setModal(null);
        await refresh();
        notify("Your new password is set.");
      } finally {
        setBusy(false);
      }
    }}
  />;
  if (user.role !== "admin" && billing && !billing.paid) return <BillingScreen
    user={user}
    billing={billing}
    busy={busy}
    darkMode={darkMode}
    onToggleTheme={() => setDarkMode((enabled) => !enabled)}
    onSavePhone={(phone) => runAction(
      () => api("/billing/phone", { method: "POST", body: JSON.stringify({ phone }) }),
      "Your mobile number is saved.",
    )}
    onCreatePayment={() => runAction(
      () => api("/billing/request", { method: "POST", body: JSON.stringify({}) }),
      "Your monthly EasyPaisa payment ID is ready.",
    )}
    onSubmitPayment={(id, transactionReference) => runAction(
      () => api(`/billing/payments/${encodeURIComponent(id)}/submit`, {
        method: "POST",
        body: JSON.stringify({ transactionReference }),
      }),
      "Payment reference sent. Your Admin will verify it.",
    )}
    onLogout={logout}
  />;
  if (!data && billingError) return <BillingLoadError
    message={billingError}
    busy={busy}
    darkMode={darkMode}
    onToggleTheme={() => setDarkMode((enabled) => !enabled)}
    onRetry={() => {
      setBusy(true);
      void refresh().catch((error) => notify(error.message, "error")).finally(() => setBusy(false));
    }}
    onLogout={logout}
  />;
  if (!data) return <div className="loading-screen"><LoaderCircle className="spin" size={23} /><span>Checking your monthly access…</span></div>;

  const pageTitle = titles[page] || titles.overview;

  const handleCreateEmployee = async (values) => {
    const response = await runAction(
      () => api("/employees", { method: "POST", body: JSON.stringify({ ...values, salary: Number(values.salary) }) }),
      "A new teammate has found their place.",
    );
    setModal({ type: "invite", name: response.employee.name, email: response.employee.email, role: "Employee", signupCode: response.signupCode });
  };

  const handleCreateHr = async (values) => {
    const response = await runAction(
      () => api("/users/hr", { method: "POST", body: JSON.stringify(values) }),
      "Your new HR account is ready.",
    );
    setModal({ type: "invite", name: response.user.name, email: response.user.email, role: "HR", signupCode: response.signupCode });
  };

  const handleAttendance = async () => {
    const route = myToday?.checkOut ? null : myToday ? "/attendance/check-out" : "/attendance/check-in";
    if (!route) return notify("You’ve already checked out for today.", "error");
    await runAction(() => api(route, { method: "POST", body: JSON.stringify({}) }), myToday ? "Checked out. Hope you had a good day." : "You’re checked in. Here’s to a good day.");
  };

  const handleLeaveReview = async (leave, status) => {
    const defaultReply = status === "Approved" ? "Your leave request has been approved." : "Please contact HR to discuss your leave request.";
    const comment = window.prompt("Write a reply for the employee:", defaultReply);
    if (comment === null) return;
    if (comment.trim().length < 2) {
      notify("Write a short reply before reviewing this leave request.", "error");
      return;
    }
    try {
      await runAction(
        () => api(`/leave/${leave.id}`, { method: "PATCH", body: JSON.stringify({ status, comment: comment.trim() }) }),
        `Leave ${status.toLowerCase()} and reply sent.`,
      );
    } catch {
      // The shared error toast explains a failed review.
    }
  };

  const handlePayroll = async () => {
    await runAction(
      () => api("/payroll/run", { method: "POST", body: JSON.stringify({ month: monthNow() }) }),
      "Your monthly payroll draft is ready for review.",
    );
  };

  const handleFinalize = async (run) => {
    if (!window.confirm(`Finalize the ${run.month} payroll? Finalized runs cannot be changed.`)) return;
    await runAction(
      () => api(`/payroll/${run.id}/finalize`, { method: "POST", body: JSON.stringify({}) }),
      "Payroll finalized and locked.",
    );
  };

  const downloadPayslip = (slip) => {
    const text = `${data.company.name}\n${slip.month} · PAYSLIP\n\nEmployee: ${currentEmployee?.name || user.name}\nBasic salary: ${money(slip.basic)}\nGross pay: ${money(slip.gross)}\nDeductions: ${money(slip.deductions)}\nTax: ${money(slip.tax)}\nTake-home pay: ${money(slip.net)}\n\nGenerated from your HCM Lite payroll record.`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `payslip-${slip.month}.txt`; anchor.click();
    URL.revokeObjectURL(url);
  };

  const loadConversation = async (id) => {
    setConversationId(id);
    localStorage.setItem(`hcm-chat-${user.id}`, id);
    setChatLoading(true);
    try {
      const result = await api(`/ai/conversations/${id}/messages`);
      setMessages(result.messages);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setChatLoading(false);
    }
  };

  const startConversation = async () => {
    try {
      const result = await api("/ai/conversations", { method: "POST", body: JSON.stringify({}) });
      setConversations((existing) => [result.conversation, ...existing]);
      setConversationId(result.conversation.id);
      setMessages([]);
      localStorage.setItem(`hcm-chat-${user.id}`, result.conversation.id);
    } catch (error) {
      notify(error.message, "error");
    }
  };

  const deleteConversation = async (id) => {
    setDeleteChatTarget(conversations.find((item) => item.id === id) || { id, title: "this conversation" });
  };

  const confirmDeleteConversation = async () => {
    if (!deleteChatTarget || deleteChatBusy) return;
    setDeleteChatBusy(true);
    try {
      await api(`/ai/conversations/${deleteChatTarget.id}`, { method: "DELETE" });
      const remaining = conversations.filter((item) => item.id !== deleteChatTarget.id);
      setConversations(remaining);
      setDeleteChatTarget(null);
      if (conversationId === deleteChatTarget.id) {
        setConversationId(null);
        setMessages([]);
        localStorage.removeItem(`hcm-chat-${user.id}`);
        if (remaining[0]) await loadConversation(remaining[0].id);
      }
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setDeleteChatBusy(false);
    }
  };

  const queueChatFiles = (chosen) => {
    const combined = [...chatAttachments, ...chosen];
    if (combined.length > 3) {
      notify("Attach up to 3 files to one Copilot message.", "error");
      return;
    }
    if (combined.some((file) => file.size > 3 * 1024 * 1024)) {
      notify("Each attachment must be 3 MB or smaller.", "error");
      return;
    }
    if (combined.reduce((total, file) => total + file.size, 0) > 6 * 1024 * 1024) {
      notify("Attachments must total 6 MB or less.", "error");
      return;
    }
    setChatAttachments(combined);
  };

  const addChatFiles = (event) => {
    const chosen = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    queueChatFiles(chosen);
  };

  const pasteChatImage = (event) => {
    const supportedExtensions = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    const items = Array.from(event.clipboardData?.items || []);
    const images = items
      .filter((item) => item.kind === "file" && supportedExtensions[item.type])
      .map((item, index) => {
        const file = item.getAsFile();
        if (!file) return null;
        const extension = supportedExtensions[item.type];
        const name = file.name && file.name.toLowerCase().endsWith(`.${extension}`)
          ? file.name
          : `pasted-image-${Date.now()}-${index + 1}.${extension}`;
        return new File([file], name, { type: item.type });
      })
      .filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    queueChatFiles(images);
  };

  const sendQuestion = async (text, files = chatAttachments) => {
    const question = text.trim();
    if ((!question && !files.length) || chatSending) return;
    setChatSending(true);
    setChatAttachments([]);
    setMessages((existing) => [...existing, {
      role: "user",
      text: question || "Please review these files.",
      attachments: files.map((file) => ({ name: file.name, pending: true })),
    }]);
    let activeConversationId = conversationId;
    try {
      if (!activeConversationId) {
        const created = await api("/ai/conversations", { method: "POST", body: JSON.stringify({}) });
        activeConversationId = created.conversation.id;
        setConversationId(activeConversationId);
        setConversations((existing) => [created.conversation, ...existing]);
        localStorage.setItem(`hcm-chat-${user.id}`, activeConversationId);
      }
      const encodedAttachments = await Promise.all(files.map(encodeFile));
      const result = await api("/ai/chat", {
        method: "POST",
        body: JSON.stringify({ question, conversationId: activeConversationId, attachments: encodedAttachments }),
      });
      const loaded = await api(`/ai/conversations/${activeConversationId}/messages`);
      setMessages(loaded.messages);
      setConversations((existing) => [
        { id: activeConversationId, title: question || files[0]?.name || "New conversation", updatedAt: new Date().toISOString() },
        ...existing.filter((item) => item.id !== activeConversationId),
      ]);
      if (result.mode === "policy") notify("I can only help with your own private pay information.", "error");
    } catch (error) {
      if (activeConversationId) {
        try {
          const loaded = await api(`/ai/conversations/${activeConversationId}/messages`);
          const lastMessage = loaded.messages[loaded.messages.length - 1];
          setMessages(lastMessage?.role === "assistant" && lastMessage.text === error.message
            ? loaded.messages
            : [...loaded.messages, { role: "assistant", text: error.message, mode: "error" }]);
        } catch {
          setMessages((existing) => [...existing, { role: "assistant", text: error.message, mode: "error" }]);
        }
      } else {
        setMessages((existing) => [...existing, { role: "assistant", text: error.message, mode: "error" }]);
      }
    } finally {
      setChatSending(false);
    }
  };

  const open = (type) => { setModal({ type }); setMenuOpen(false); };

  return <>
    <div className="workspace">
      {menuOpen && <button className="mobile-backdrop open" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <IconBrand />
        <div className="workspace-tag">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          {visibleNavigation.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-link ${page === id ? "active" : ""}`} type="button" onClick={() => go(id)}>
            <Icon size={17} strokeWidth={1.7} /><span className="nav-label">{label}</span>
            {id === "leave" && pendingCount > 0 && user.role !== "employee" && <span className="nav-count">{pendingCount}</span>}
          </button>)}
        </nav>
        <div className="sidebar-bottom">
          {user.role !== "employee" && <div className="ai-promo"><span className="ai-promo-icon"><Sparkles size={16} /></span><h3>A little help from Copilot</h3><p>Ask people questions in plain language. Answers stay grounded in your data.</p><button type="button" onClick={() => go("assistant")}>Meet your Copilot <ArrowRight size={12} /></button></div>}
          <div className="profile-strip">
            <Avatar name={user.name} />
            <span className="profile-info"><span className="profile-name">{user.name}</span><span className="profile-role">{user.role === "hr" ? "HR" : user.role === "employee" ? "Employee" : "Admin"} · {data.company.name}</span></span>
            <button className="profile-signout" type="button" onClick={logout}><LogOut size={14} /><span>Sign out</span></button>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <button className="icon-btn mobile-menu" type="button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <span className="mobile-brand"><IconBrand /></span>
          <div className="breadcrumbs">{data.company.name} <span className="crumb-divider">/</span> <strong>{pageTitle[0]}</strong></div>
          <div className="top-actions"><span className="secure-pill"><span className="online-dot" /> Secure workspace</span><ThemeToggle darkMode={darkMode} onToggle={() => setDarkMode((enabled) => !enabled)} /><span className="role-pill">{user.role === "hr" ? "HR" : user.role === "employee" ? "Employee" : "Admin"} view</span><button className="topbar-signout" type="button" onClick={logout} title="Sign out" aria-label="Sign out"><LogOut size={14} /><span>Sign out</span></button></div>
        </header>
        <main className="content">
          {renderPage()}
          <p className="footer-note">A little clarity goes a long way · {data.company.name}</p>
        </main>
      </div>
    </div>
    {cameraAttendance && attendanceAction && user.role === "employee" && faceTemplateReady && isOfficeKioskOrigin() && <FaceCameraModal
      mode={faceTemplate ? "verify" : "enroll"}
      action={attendanceAction}
      name={user.name}
      expectedDescriptor={faceTemplate}
      busy={busy}
      onConfirm={handleAttendance}
      onEnroll={async (descriptor) => {
        await saveFaceTemplate(user.id, descriptor);
        setFaceTemplate(descriptor);
        notify("Face template saved on this office kiosk. Use it for your next attendance check-in.");
      }}
      onForget={async () => {
        await deleteFaceTemplate(user.id);
        setFaceTemplate(null);
        notify("The local face template was removed from this kiosk.");
      }}
      onClose={() => setCameraAttendance(false)}
    />}
    {modal && renderModal()}
    {deleteChatTarget && <Modal
      title="Delete chat?"
      subtitle={`“${deleteChatTarget.title}” and its attached files will be permanently deleted. This can’t be undone.`}
      onClose={() => setDeleteChatTarget(null)}
      busy={deleteChatBusy}
    >
      <div className="delete-chat-icon"><Trash2 size={20} /></div>
      <div className="modal-actions delete-chat-actions">
        <button className="secondary-btn" type="button" disabled={deleteChatBusy} onClick={() => setDeleteChatTarget(null)}>Cancel</button>
        <button className="danger-btn" type="button" disabled={deleteChatBusy} onClick={() => void confirmDeleteConversation()}>
          {deleteChatBusy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
          {deleteChatBusy ? "Deleting…" : "Delete chat"}
        </button>
      </div>
    </Modal>}
    {toast && <div className="toast-region"><div className={`toast ${toast.kind === "error" ? "error" : ""}`} role="status"><span className="toast-symbol">{toast.kind === "error" ? <XCircle size={15} /> : <Check size={15} />}</span><span>{toast.message}</span></div></div>}
  </>;

  function renderPageIntro(actions = null) {
    return <div className="page-intro"><div><div className="page-kicker">{data.company.name} <span className="crumb-divider">/</span> PEOPLE & CULTURE</div><h1 className="page-title">{pageTitle[0]}</h1><p className="page-subtitle">{pageTitle[1]}</p></div><div className="intro-actions">{actions}</div></div>;
  }

  function metric(label, value, Icon, color = "", change = "", caption = "") {
    return <article className="metric-card" key={label}><div className="metric-top"><span>{label}</span><span className={`metric-icon ${color}`}><Icon size={17} /></span></div><div className="metric-value">{value}{change && <span className="metric-change">{change}</span>}</div><div className="metric-caption">{caption}</div></article>;
  }

  function empty(title, copy, Icon = Users, action = null) {
    return <div className="empty-state"><span className="empty-icon"><Icon size={20} /></span><h3>{title}</h3><p>{copy}</p>{action}</div>;
  }

  function tableEmployees(people) {
    if (!people.length) return empty("Your first hello is just around the corner", "Add a teammate to see your growing team here.", Users,
      user.role !== "employee" && <button className="primary-btn" type="button" onClick={() => open("employee")}><Plus size={14} /> Add your first person</button>);
    return <div className="table-wrap"><table className="data-table"><thead><tr><th>PERSON</th><th>TEAM</th><th>STARTED</th><th>STATUS</th></tr></thead><tbody>
      {people.map((employee, index) => <tr key={employee.id}><td><div className="employee-cell"><Avatar name={employee.name} index={index} /><span><strong>{employee.name}</strong><small>{employee.title}</small></span></div></td><td>{employee.department}</td><td>{dateLabel(employee.joined)}</td><td><Status>{employee.status}</Status></td></tr>)}
    </tbody></table></div>;
  }

  function panelHead(title, caption, Icon = Sparkles, action = null) {
    return <div className="panel-head"><div><h2 className="panel-title">{title}</h2><p className="panel-caption">{caption}</p></div>{action || <span className="metric-icon"><Icon size={17} /></span>}</div>;
  }

  function announcementCard(item, index) {
    return <div className="announcement-card" key={item.id}><Avatar name={item.author} index={index} /><span className="announcement-copy"><h4>{item.title}</h4><p>{item.body}</p><span className="announcement-date">{item.author} · {dateLabel(item.date)}</span></span></div>;
  }

  function attendanceTable(records = attendance) {
    if (!records.length) return empty("It’s a fresh start", "Check-ins will take their place here, one day at a time.", Clock3,
      user.role === "employee" && <button className="primary-btn" type="button" disabled={!faceTemplateReady || !isOfficeKioskOrigin()} onClick={() => setCameraAttendance(true)}><Camera size={14} /> {attendanceButtonLabel}</button>);
    return <div className="table-wrap"><table className="data-table"><thead><tr><th>DAY</th><th>PERSON</th><th>IN</th><th>OUT</th><th>STATUS</th></tr></thead><tbody>
      {records.map((record, index) => <tr key={record.id}><td>{dateLabel(record.date)}</td><td><div className="employee-cell"><Avatar name={record.name} index={index} /><span><strong>{record.name}</strong><small>{record.department}</small></span></div></td><td>{record.checkIn ? new Date(record.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td><td>{record.checkOut ? new Date(record.checkOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td><td><Status>{record.status}</Status></td></tr>)}
    </tbody></table></div>;
  }

  function leaveCard(leave, index) {
    return <div className="announcement-card" key={leave.id}><Avatar name={employeeList.find((item) => item.id === leave.employeeId)?.name || user.name} index={index} /><span className="announcement-copy"><h4>{employeeList.find((item) => item.id === leave.employeeId)?.name || "You"} <span className="lighter-text">· {leave.type} leave</span></h4><p>{dateLabel(leave.start)} – {dateLabel(leave.end)} · {leave.days} {leave.days === 1 ? "day" : "days"}<br />{leave.reason}</p><span className="announcement-date"><Status>{leave.status}</Status>{leave.reviewComment && ` · ${leave.reviewComment}`}</span>
      {user.role !== "employee" && leave.status === "Pending" && <span className="review-actions"><button className="ghost-btn" type="button" onClick={() => handleLeaveReview(leave, "Declined")}>Decline</button><button className="ghost-btn" type="button" onClick={() => handleLeaveReview(leave, "Approved")}>Approve</button></span>}</span></div>;
  }

  function renderOverview() {
    const present = summary?.present || 0;
    const pending = summary?.pendingLeaves || 0;
    const employee = user.role === "employee";
    const payroll = data.payrollRuns[0];
    const mainCards = employee ? [
      metric("Hours this week", "—", Clock3, "blue", "", "Your timesheet will tell the story"),
      metric("Days in the office", attendance.filter((record) => record.employeeId === user.id && record.date.startsWith(monthNow())).length, Clock3, "", "", "This month"),
      metric("Leave in your pocket", Object.values(data.balance || {}).filter((value) => value !== null).reduce((sum, value) => sum + value, 0), CalendarDays, "amber", "", "Across your leave types"),
      metric("Last payslip", money(data.payslips[0]?.net, true), WalletCards, "", "", data.payslips[0] ? data.payslips[0].month : "Your first payslip awaits"),
    ] : [
      metric("The team", summary?.headcount || 0, Users, "", "", "Every person belongs here"),
      metric("Here today", `${present}/${summary?.headcount || 0}`, Clock3, "blue", "", "Present or just a little late"),
      metric("Taking a little time", pending, CalendarDays, "amber", "", "Requests awaiting a kind look"),
      metric("People cost · month", money(payroll?.gross, true), WalletCards, "rose", payroll?.status || "", payroll ? `${payroll.month} payroll` : "Run your first payroll when ready"),
    ];
    const peopleTeams = Object.entries(employeeList.reduce((groups, person) => {
      groups[person.department] = (groups[person.department] || 0) + 1;
      return groups;
    }, {}));
    const attendanceToday = attendance.filter((record) => record.date === todayString);
    return <>
      {renderPageIntro(employee
        ? <><button className="secondary-btn" type="button" onClick={() => setCameraAttendance(true)} disabled={!attendanceAction || !faceTemplateReady || !isOfficeKioskOrigin()}><Camera size={14} /> {attendanceButtonLabel}</button><button className="primary-btn" type="button" onClick={() => open("leave")}><Plus size={14} /> Request time off</button></>
        : <><button className="secondary-btn" type="button" onClick={() => go("assistant")}><Sparkles size={14} /> Summarize</button><button className="primary-btn" type="button" onClick={() => open(user.role === "admin" ? "employee" : "employee")}><Plus size={14} /> Add a person</button></>)}
      <div className="metric-grid">{mainCards}</div>
      <div className="section-grid">
        <section className="panel">{panelHead(employee ? "Your people, at a glance" : "People, by team", employee ? "Your team is here when you need them." : "The people and different strengths in your team.", Users)}
          {employee ? <div className="notice-box">{<Sparkles size={15} />}<span>Your private employee details stay yours. Your HR team can help with anything you need.</span></div>
            : employeeList.length ? <div className="attendance-list">{peopleTeams.map(([department, count], index) => <div className="department-row" key={department}><span>{department}</span><span className="progress-track"><span className={`progress-fill ${["", "amber", "blue", "rose"][index % 4]}`} style={{ width: `${Math.max(12, count / employeeList.length * 100)}%` }} /></span><span className="department-count">{count}</span></div>)}</div>
              : empty("A lovely blank canvas", "Your first teammate will help your team take shape.", Users, <button className="primary-btn" type="button" onClick={() => open("employee")}><Plus size={14} /> Add a person</button>)}
        </section>
        <section className="panel">{panelHead(employee ? "A note from your team" : "A little inbox", employee ? "The latest from the people around you." : "Leave requests to look over.", CalendarDays,
          <button className="ghost-btn" type="button" onClick={() => go(employee ? "announcements" : "leave")}>See all <ArrowRight size={12} /></button>)}
          {employee
            ? data.announcements.slice(0, 2).map(announcementCard)
            : leaves.filter((leave) => leave.status === "Pending").slice(0, 3).map(leaveCard)}
          {!employee && pending === 0 && empty("Inbox all caught up", "New requests will find their way here.", CalendarDays)}
          {employee && data.announcements.length === 0 && empty("A fresh page", "Team updates will find their way here.", Megaphone)}
        </section>
      </div>
      {!employee && <div className="section-grid">
        <section className="panel">{panelHead("A few familiar faces", "Here, showing up and making it happen.", Users,
          <button className="ghost-btn" type="button" onClick={() => go("employees")}>See all <ArrowRight size={12} /></button>)}{tableEmployees(employeeList.slice(0, 5))}</section>
        <section className="panel">{panelHead("Today, together", `${dateLabel(todayString)} · attendance`, Clock3)}
          {attendanceToday.length ? <div className="mini-summary">{attendanceToday.slice(0, 4).map((record, index) => <div className="summary-row" key={record.id}><Avatar name={record.name} index={index} /><span className="summary-copy"><strong>{record.name}</strong>{record.department}</span><Status>{record.status}</Status></div>)}</div> : empty("A fresh start", "Check-ins from today will show up here.", Clock3)}
          <button className="ghost-btn" type="button" onClick={() => go("attendance")}>Attendance <ArrowRight size={12} /></button>
        </section>
      </div>}
      {employee && <div className="section-grid"><section className="panel">{panelHead("Your recent activity", "A few recent check-ins.", Clock3)}{attendanceTable(attendance.filter((record) => record.employeeId === user.id).slice(0, 4))}</section><section className="panel">{panelHead("A little reminder", "Useful, not in a rush.", Sparkles)}<div className="notice-box"><Sparkles size={15} /><span>You have <strong>{Object.values(data.balance || {}).filter((value) => value !== null).reduce((sum, value) => sum + value, 0)} days of leave</strong> in your pocket. Take them when you need them.</span></div></section></div>}
    </>;
  }

  function renderEmployees() {
    const filtered = employeeList.filter((employee) => `${employee.name} ${employee.department} ${employee.title} ${employee.email}`.toLowerCase().includes(query.toLowerCase()));
    return <>{renderPageIntro(<><button className="secondary-btn" type="button" onClick={exportCsv}><ArrowDownToLine size={14} /> Export CSV</button><button className="primary-btn" type="button" onClick={() => open("employee")}><Plus size={14} /> Add a person</button></>)}
      <div className="metric-grid">{metric("People on the team", employeeList.length, Users, "", "", "Every person belongs here")}{metric("Departments", new Set(employeeList.map((person) => person.department)).size, LayoutDashboard, "blue", "", "Different strengths, one team")}{metric("Active teammates", employeeList.filter((person) => person.status === "Active").length, CheckCheck, "amber", "", "Here and making it happen")}{metric("People operations", "Thoughtfully", Sparkles, "rose", "", "Built for the work behind the work")}</div>
      <section className="panel" style={{ marginTop: 15 }}>{panelHead("Everyone, at a glance", `${filtered.length} kind people${query ? " matching your search" : " in your workspace"}`, Users)}<div className="table-toolbar"><input className="search-field" placeholder="Find someone by name or team…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="status neutral">{new Set(employeeList.map((person) => person.department)).size} teams</span></div>{tableEmployees(filtered)}</section>
    </>;
  }

  function renderAttendance() {
    const present = attendance.filter((record) => record.date === todayString && ["Present", "Late"].includes(record.status)).length;
    return <>{renderPageIntro(user.role === "employee"
      ? <button className="primary-btn" type="button" onClick={() => setCameraAttendance(true)} disabled={!attendanceAction || !faceTemplateReady || !isOfficeKioskOrigin()}><Camera size={14} /> {attendanceButtonLabel}</button>
      : null)}
      <div className="metric-grid">{metric("Here today", `${present}/${summary?.headcount || 0}`, Users, "", "", "Present or just a little late")}{metric("On time", attendance.filter((record) => record.date === todayString && record.status === "Present").length, CheckCheck, "blue", "", "A lovely start to the day")}{metric("Running behind", summary?.late || 0, Clock3, "amber", "", `Grace until ${data.company.officeStart} + ${data.company.graceMinutes} min`)}{metric("Total records", attendance.length, CalendarDays, "rose", "", "A thoughtful record of time")}</div>
      <section className="panel" style={{ marginTop: 15 }}>{panelHead("A day in the life", "Times are stamped and saved on the server.", Clock3)}{attendanceTable()}</section>
    </>;
  }

  function renderLeave() {
    const filtered = leaves.filter((leave) => leaveFilter === "all" || leave.status.toLowerCase() === leaveFilter);
    return <>{renderPageIntro(user.role === "employee" ? <button className="primary-btn" type="button" onClick={() => open("leave")}><Plus size={14} /> Ask for time off</button> : null)}
      {user.role === "employee" && <section className="panel" style={{ marginBottom: 15 }}>{panelHead("Your leave, your way", "A few days for rest, recharge, and real life.", CalendarDays)}<div className="leave-grid">{["Annual", "Sick", "Casual"].map((type) => <div className="leave-balance" key={type}><div className="balance-name">{type} days left</div><div className="balance-value">{data.balance?.[type] ?? 0}</div><div className="balance-caption">of {{ Annual: 14, Sick: 8, Casual: 10 }[type]} days this year</div></div>)}</div></section>}
      <div className="metric-grid">{metric("A little inbox", pendingCount, CalendarDays, "amber", "", "Requests waiting for a kind look")}{metric("Approved this year", leaves.filter((leave) => leave.status === "Approved").length, CheckCheck, "", "", "Time away, well spent")}{metric("How we work", "14 days", Sparkles, "blue", "", "Annual leave allowance")}{metric("Good to know", "Weekdays", Clock3, "rose", "", "Weekends are skipped")}</div>
      <section className="panel" style={{ marginTop: 15 }}>{panelHead(user.role === "employee" ? "Your leave story" : "A little time, when it matters", `${pendingCount} ${pendingCount === 1 ? "request" : "requests"} waiting`, CalendarDays)}<div className="filter-row">{["all", "pending", "approved", "declined"].map((filter) => <button className={`ghost-btn ${leaveFilter === filter ? "filter-active" : ""}`} key={filter} type="button" onClick={() => setLeaveFilter(filter)}>{filter[0].toUpperCase() + filter.slice(1)}</button>)}</div>{filtered.length ? filtered.map(leaveCard) : empty("No leave just yet", "Leave requests will find their way here when someone asks for time.", CalendarDays, user.role === "employee" && <button className="primary-btn" type="button" onClick={() => open("leave")}><Plus size={14} /> Ask for time off</button>)}</section>
    </>;
  }

  function renderPayroll() {
    const runs = data.payrollRuns || [];
    const ownSlips = data.payslips || [];
    return <>{renderPageIntro(user.role === "employee"
      ? <button className="secondary-btn" type="button" disabled={!ownSlips[0]} onClick={() => ownSlips[0] && downloadPayslip(ownSlips[0])}><ArrowDownToLine size={14} /> Download payslip</button>
      : <button className="secondary-btn" type="button" onClick={handlePayroll}><WalletCards size={14} /> Run this month</button>)}
      <div className="metric-grid">{metric(user.role === "employee" ? "Your take-home" : "Payroll runs", user.role === "employee" ? money(ownSlips[0]?.net) : runs.length, WalletCards, "", "", ownSlips[0]?.month || "A little clearer, every payday")}{metric(user.role === "employee" ? "Gross pay" : "Latest payroll", user.role === "employee" ? money(ownSlips[0]?.gross) : runs[0]?.month || "Not yet run", Clock3, "blue", "", runs[0]?.status || "Run your first payroll when ready")}{metric("Payslips", user.role === "employee" ? ownSlips.length : runs.reduce((sum, run) => sum + Number(run.employees), 0), FileText, "amber", "", "Saved payroll records")}{metric("People cost", money(runs[0]?.gross, true), Users, "rose", "", "Latest monthly gross")}</div>
      <section className="panel" style={{ marginTop: 15 }}>{panelHead(user.role === "employee" ? "Your payslips" : "A history of payroll", "Payroll calculations are saved and prepared on the server.", WalletCards)}
        {user.role === "employee"
          ? ownSlips.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>MONTH</th><th>GROSS</th><th>DEDUCTIONS</th><th>TAKE-HOME</th><th>STATUS</th><th /></tr></thead><tbody>{ownSlips.map((slip) => <tr key={slip.id}><td>{slip.month}</td><td>{money(slip.gross)}</td><td>{money(slip.deductions + slip.tax)}</td><td>{money(slip.net)}</td><td><Status>{slip.status}</Status></td><td><button className="ghost-btn" type="button" onClick={() => downloadPayslip(slip)}>Download</button></td></tr>)}</tbody></table></div> : empty("Your first payslip will be right here", "Once your HR team runs payroll, you can find your payslips here.", WalletCards)
          : runs.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>MONTH</th><th>PEOPLE</th><th>GROSS</th><th>TAKE-HOME</th><th>STATUS</th><th /></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td><strong>{run.month}</strong></td><td>{run.employees}</td><td>{money(run.gross)}</td><td>{money(run.net)}</td><td><Status>{run.status}</Status></td><td>{user.role === "admin" && run.status === "Draft" && <button className="ghost-btn" type="button" onClick={() => handleFinalize(run)}>Finalize</button>}</td></tr>)}</tbody></table></div>
            : empty("A blank page, ready for payday", "Run payroll when your team is ready. Every number will be calculated from your saved records.", WalletCards, employeeList.length > 0 && user.role !== "employee" && <button className="secondary-btn" type="button" onClick={handlePayroll}>Run this month</button>)}
      </section>
    </>;
  }

  function renderAssistant() {
    const prompts = user.role === "employee"
      ? ["How much leave do I have left?", "What is our annual leave allowance?", "Can I see my attendance?"]
      : ["How many people are here today?", "How many leave requests are waiting?", "Summarize our people this week"];
    const history = messages;
    const messageLabel = (message) => message.role === "user" ? "YOU"
      : message.mode === "image-generation" ? "IMAGE GENERATION"
      : message.mode === "copilot" ? "GITHUB COPILOT"
        : message.mode === "policy" ? "WORKSPACE POLICY"
          : message.mode === "error" ? "AI ERROR"
            : "ASSISTANT";
    return <>{renderPageIntro()}<div className="chat-layout">
      <section className="panel chat-panel">
        {panelHead("A conversation, not a command.", <><span className="online-dot inline-dot" /> GitHub Copilot · your own account</>, MessageCircle, <button className="secondary-btn" type="button" onClick={() => void startConversation()}><MessageSquarePlus size={14} /> New chat</button>)}
        <div className="chat-messages" id="chat-messages" aria-live="polite">
          {chatLoading && <div className="chat-loading"><LoaderCircle className="spin" size={15} /> Loading your conversations…</div>}
          {history.map((message, index) => <div className={`chat-message ${message.role === "user" ? "user" : ""}`} key={message.id || `${index}-${message.role}`}>
            <Avatar name={message.role === "user" ? user.name : "AI"} index={message.role === "user" ? 1 : 0} />
            <span className="message-bubble">
              <span className="message-tag">{messageLabel(message)}</span>
              {message.text}
              {!!message.attachments?.length && <span className="message-attachments">{message.attachments.map((file, fileIndex) => file.pending
                ? <span className="message-file" key={`${file.name}-${fileIndex}`}><Paperclip size={13} /> {file.name}</span>
                : <a className="message-file" href={file.url} target="_blank" rel="noreferrer" key={file.id}>
                  {file.mimeType.startsWith("image/") && <img className="message-image" src={file.url} alt={file.name} />}
                  <Paperclip size={13} /> {file.name}
                </a>)}</span>}
            </span>
          </div>)}
          {chatSending && <div className="chat-loading"><LoaderCircle className="spin" size={15} /> Copilot is reviewing your message…</div>}
        </div>
        {chatAttachments.length > 0 && <div className="chat-pending-files">{chatAttachments.map((file, index) =>
          <span className="chat-pending-file" key={`${file.name}-${index}`}><Paperclip size={13} /> {file.name}
            <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setChatAttachments((existing) => existing.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button>
          </span>)}</div>}
        <form className="chat-composer" onSubmit={(event) => {
          event.preventDefault();
          const field = event.currentTarget.elements.question;
          const value = field.value;
          field.value = "";
          void sendQuestion(value, chatAttachments);
        }}>
          <label className="chat-attach-btn" title="Attach images or documents">
            <Paperclip size={17} />
            <input type="file" aria-label="Attach images or documents" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json,.docx,.xlsx,.pptx" onChange={addChatFiles} disabled={chatSending} />
          </label>
          <input className="field" name="question" maxLength={1000} placeholder="Ask or paste an image…" aria-label="Ask your people assistant or paste an image" onPaste={pasteChatImage} disabled={chatSending} />
          <button className="primary-btn" aria-label="Send message" disabled={chatSending}><ArrowRight size={15} /></button>
        </form>
      </section>
      <aside className="panel chat-sidebar">
        {panelHead("Your conversations", "Private chat history for this account.", MessageCircle)}
        <div className="chat-history-list">{conversations.length
          ? conversations.map((item) => <div className={`chat-history-item ${conversationId === item.id ? "active" : ""}`} key={item.id}>
            <button type="button" onClick={() => void loadConversation(item.id)} title={item.title}>{item.title}</button>
            <button type="button" aria-label={`Delete ${item.title}`} title="Delete conversation" onClick={() => void deleteConversation(item.id)}><X size={13} /></button>
          </div>)
          : <p className="chat-history-empty">Your saved conversations will appear here.</p>}</div>
        <div className="chat-suggestions-heading">Try asking</div>
        <div className="suggestion-list">{prompts.map((prompt) => <button className="suggestion" type="button" key={prompt} onClick={() => void sendQuestion(prompt)}>{prompt}</button>)}</div>
        <div className="onboarding-note" style={{ marginTop: 18 }}><Sparkles size={14} /><span>Attach up to 3 images or documents (3 MB each, 6 MB total) for Copilot to review. Image creation and editing use the local ComfyUI service when it is running.</span></div>
      </aside>
    </div></>;
  }

  function renderAnnouncements() {
    const canPost = ["admin", "hr"].includes(user.role);
    return <>{renderPageIntro(canPost && <button className="primary-btn" type="button" onClick={() => open("announcement")}><Plus size={14} /> Share an update</button>)}
      <div className="section-grid equal"><section className="panel">{panelHead("From your people", "A little news, whenever there’s something to share.", Megaphone)}
        {data.announcements.length ? data.announcements.map(announcementCard) : empty("A fresh page", "There are no announcements just yet.", Megaphone, canPost && <button className="primary-btn" type="button" onClick={() => open("announcement")}><Plus size={14} /> Share an update</button>)}</section>
        <aside className="panel">{panelHead("How we keep in touch", "The little rules that keep us in the loop.", Bell)}<div className="mini-summary"><div className="summary-row"><span className="summary-symbol"><Megaphone size={15} /></span><span className="summary-copy"><strong>Updates from the team</strong>New announcements show up here.</span></div><div className="summary-row"><span className="summary-symbol blue"><Bell size={15} /></span><span className="summary-copy"><strong>A little heads-up</strong>Notifications help you keep up.</span></div></div></aside></div>
    </>;
  }

  function renderProfile() {
    if (!profile) return <>{renderPageIntro()}<section className="panel">{empty("Loading your profile", "Your work details are on their way.", Users)}</section></>;
    return <>{renderPageIntro()}<section className="panel profile-panel">{panelHead("Your details", "Only your contact information can be changed here.", Users)}
      <form onSubmit={async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        setProfileBusy(true);
        try {
          await runAction(
            () => api("/profile", { method: "PATCH", body: JSON.stringify(values) }),
            "Your profile is up to date.",
            (result) => setProfile((current) => ({ ...current, ...result.profile })),
          );
        } catch {
          // The shared error toast explains a failed save.
        } finally {
          setProfileBusy(false);
        }
      }}>
        <div className="profile-readonly-grid">
          <div><span>Name</span><strong>{profile.name}</strong></div>
          <div><span>Work email</span><strong>{profile.email}</strong></div>
          <div><span>Role</span><strong>{profile.role === "hr" ? "HR" : profile.role === "employee" ? "Employee" : "Admin"}</strong></div>
          {profile.department && <div><span>Department</span><strong>{profile.department}</strong></div>}
          {profile.title && <div><span>Job title</span><strong>{profile.title}</strong></div>}
        </div>
        <div className="profile-edit-grid">
          <Field label="Phone" id="profilePhone" name="phone" type="tel" autoComplete="tel" maxLength={30} defaultValue={profile.phone || ""} />
          <div className="form-group"><label className="form-label" htmlFor="profileAddress">Address</label><textarea className="field" id="profileAddress" name="address" autoComplete="street-address" maxLength={250} defaultValue={profile.address || ""} /></div>
        </div>
        <button className="primary-btn" type="submit" disabled={busy || profileBusy}>{profileBusy ? <><LoaderCircle className="spin" size={15} /> Saving…</> : "Save profile"}</button>
      </form>
    </section></>;
  }

  function renderSettings() {
    return <>{renderPageIntro()}
      <section className="panel account-security-panel">{panelHead("Your GitHub Copilot account", "Connect your own GitHub account with Copilot access. Its usage allowance applies to your chats.", Sparkles)}
        <div className="setting-row"><span className="setting-label"><strong>Connection</strong><span>{copilotStatusBusy ? "Checking your connection…" : copilotConnected ? "Your GitHub account is connected." : "Not connected yet."}</span></span>
          <div className="modal-actions">
            {copilotConnected
              ? <button className="secondary-btn" type="button" disabled={copilotConnecting} onClick={async () => {
                if (!window.confirm("Disconnect your GitHub Copilot account from this HCM account?")) return;
                setCopilotConnecting(true);
                try {
                  await api("/ai/copilot/connect", { method: "DELETE" });
                  setCopilotConnected(false);
                  notify("Your GitHub Copilot account was disconnected.");
                } catch (error) {
                  notify(error.message, "error");
                } finally {
                  setCopilotConnecting(false);
                }
              }}>{copilotConnecting ? "Disconnecting…" : "Disconnect Copilot"}</button>
              : <button className="primary-btn" type="button" disabled={copilotStatusBusy || copilotConnecting} onClick={async () => {
                setCopilotConnecting(true);
                try {
                  const result = await api("/ai/copilot/connect", { method: "POST", body: JSON.stringify({}) });
                  window.location.assign(result.url);
                } catch (error) {
                  notify(error.message, "error");
                  setCopilotConnecting(false);
                }
              }}>{copilotConnecting ? "Opening GitHub…" : "Connect GitHub Copilot"}</button>}
          </div>
        </div>
        <p className="form-hint">Your GitHub token is encrypted in the server database, used only for your own Copilot requests, and never sent to other HCM users. Copilot receives only the workspace data permitted for your role.</p>
      </section>
      <section className="panel account-security-panel">{panelHead("Change your password", "Update the password you use to sign in.", Settings)}
        <form onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = Object.fromEntries(new FormData(form));
          if (values.newPassword !== values.confirmPassword) {
            notify("Those new passwords don’t match.", "error");
            return;
          }
          try {
            await runAction(
              () => api("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) }),
              "Your new password is set.",
            );
            form.reset();
          } catch {
            // The shared error toast explains a failed save.
          }
        }}>
          <div className="password-fields">
            <Field label="Current password" name="currentPassword" type="password" required autoComplete="current-password" />
            <Field label="New password" name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" hint="Use at least 12 characters." />
            <Field label="Confirm new password" name="confirmPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
          </div>
          <button className="primary-btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
        </form>
      </section>
      {user.role === "admin" && <div className="settings-grid"><section className="panel">{panelHead("The working day, your way", "Everyday details to keep your people in sync.", Settings)}
      <form onSubmit={async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); try { await runAction(() => api("/settings", { method: "PUT", body: JSON.stringify({ ...values, graceMinutes: Number(values.graceMinutes) }) }), "Your workspace feels a little more like you."); } catch { /* The shared error toast explains a failed save. */ } }}>
        <div className="setting-row"><span className="setting-label"><strong>Company name</strong><span>What you call your corner of the world</span></span><input className="field" name="name" defaultValue={data.company.name} required maxLength={80} /></div>
        <div className="setting-row"><span className="setting-label"><strong>Workday begins</strong><span>When the day officially starts</span></span><input className="field" type="time" name="officeStart" defaultValue={data.company.officeStart} required /></div>
        <div className="setting-row"><span className="setting-label"><strong>Grace period</strong><span>A little breathing room, in minutes</span></span><input className="field" type="number" name="graceMinutes" min="0" max="120" defaultValue={data.company.graceMinutes} required /></div>
        <div className="setting-row"><span className="setting-label"><strong>Weekend</strong><span>Your days away from the desk</span></span><select className="field" name="weekend" defaultValue={data.company.weekend}><option>Saturday & Sunday</option><option>Friday & Saturday</option><option>Sunday</option></select></div>
        <div className="modal-actions"><button className="primary-btn"><Check size={14} /> Save these changes</button></div>
      </form></section>
      <aside className="panel">{panelHead("Your workspace, today", "A little sense of where you are.", Users)}<div className="mini-summary"><div className="summary-row"><span className="summary-symbol"><Users size={15} /></span><span className="summary-copy"><strong>{employeeList.length} people</strong>In your team</span></div><div className="summary-row"><span className="summary-symbol blue"><Clock3 size={15} /></span><span className="summary-copy"><strong>{attendance.length} check-ins</strong>In your workspace</span></div><div className="summary-row"><span className="summary-symbol amber"><CalendarDays size={15} /></span><span className="summary-copy"><strong>{leaves.length} leave requests</strong>Since you started</span></div></div>
      <div className="admin-tools"><div><h3>People who help manage</h3><p>Give your HR team a secure sign-in.</p></div><button className="secondary-btn" type="button" onClick={() => open("hr")}><Plus size={14} /> Add HR</button></div>
      {data.demoDataEnabled && employeeList.length === 0 && <div className="admin-tools demo-tools"><div><h3>Try a sample workspace</h3><p>Loads fictional teammates, attendance, leave and an announcement. This cannot be automatically undone.</p></div><button className="secondary-btn" type="button" onClick={async () => {
        if (!window.confirm("Load fictional demo records into this empty workspace? This cannot be automatically undone.")) return;
        try {
          await runAction(() => api("/demo/seed", { method: "POST", body: JSON.stringify({}) }), "Fictional sample data is ready.");
        } catch {
          // The shared error toast explains a failed sample-data load.
        }
      }}>Load demo data</button></div>}
      </aside></div>}
      {user.role === "admin" && <div className="settings-grid billing-admin-grid">
        <section className="panel">
          {panelHead("EasyPaisa & monthly fee", "Set the account where HR and Employees send their monthly payment.", WalletCards)}
          <form onSubmit={async (event) => {
            event.preventDefault();
            if (!event.currentTarget.reportValidity()) return;
            const values = Object.fromEntries(new FormData(event.currentTarget));
            try {
              await runAction(
                () => api("/billing/settings", {
                  method: "PUT",
                  body: JSON.stringify({ easypaisaAccount: values.easypaisaAccount, monthlyFee: Number(values.monthlyFee) }),
                }),
                "EasyPaisa payment details saved.",
              );
            } catch {
              // The shared error toast explains a failed save.
            }
          }}>
            <div className="setting-row"><span className="setting-label"><strong>EasyPaisa receiving number</strong><span>This number is shown to staff when they request this month’s payment ID.</span></span><Field name="easypaisaAccount" type="tel" autoComplete="tel" required minLength={8} maxLength={30} placeholder="03XX XXXXXXX" defaultValue={billing?.receiverAccount || ""} /></div>
            <div className="setting-row"><span className="setting-label"><strong>Monthly fee (PKR)</strong><span>Charged once per HR or Employee account each month.</span></span><Field name="monthlyFee" type="number" required min={1} max={1000000} defaultValue={billing?.monthlyFee || 1000} /></div>
            <div className="modal-actions"><button className="primary-btn" type="submit" disabled={busy}><Check size={14} /> Save payment details</button></div>
          </form>
          <p className="billing-footnote">Monthly billing starts on November 21, 2026. Payment IDs are available after the 20th and valid for 7 days. Payments are manually verified by the Admin.</p>
        </section>
        <section className="panel">
          {panelHead("Payment verification", "Check the submitted EasyPaisa reference before unlocking access.", CheckCheck)}
          {billing?.reviewQueue?.length ? <div className="billing-review-list">{billing.reviewQueue.map((payment) => <article className="billing-review-item" key={payment.id}>
            <div className="billing-review-heading"><strong>{payment.name}</strong><span className={`status ${payment.status === "rejected" ? "late" : "pending"}`}>{payment.status}</span></div>
            <p>{payment.email} · {payment.phone || "No mobile number"} · {payment.billingMonth}</p>
            <div className="billing-review-meta"><span>Amount: <strong>PKR {Number(payment.amount).toLocaleString("en-PK")}</strong></span><span>Payment ID: <strong>{payment.id}</strong></span><span>Transaction ref: <strong>{payment.transactionReference}</strong></span></div>
            {payment.status === "submitted" && <div className="modal-actions">
              <button className="secondary-btn" type="button" disabled={busy} onClick={() => void runAction(
                () => api(`/billing/payments/${encodeURIComponent(payment.id)}/review`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) }),
                `Payment from ${payment.name} marked for resubmission.`,
              ).catch(() => {})}>Decline</button>
              <button className="primary-btn" type="button" disabled={busy} onClick={() => void runAction(
                () => api(`/billing/payments/${encodeURIComponent(payment.id)}/review`, { method: "PATCH", body: JSON.stringify({ status: "paid" }) }),
                `${payment.name}’s monthly access is now active.`,
              ).catch(() => {})}><Check size={14} /> Verify payment</button>
            </div>}
          </article>)}</div> : empty("All caught up", "Submitted EasyPaisa payments will appear here for verification.", WalletCards)}
        </section>
      </div>}
    </>;
  }

  function renderAudit() {
    const logs = data.audit || [];
    return <>{renderPageIntro()}<section className="panel">{panelHead("A clear trail of decisions", "Who did what, and when. Audit entries are immutable.", FileText)}
      {logs.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>WHEN</th><th>WHO</th><th>WHAT HAPPENED</th><th>RECORD</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.date).toLocaleString()}</td><td>{log.actor}</td><td>{log.action.replaceAll(".", " ")}</td><td>{log.entityType}</td></tr>)}</tbody></table></div> : empty("A clear start", "Important actions from your workspace will appear here.", FileText)}</section></>;
  }

  function renderPage() {
    switch (page) {
      case "overview": return renderOverview();
      case "employees": return renderEmployees();
      case "attendance": return renderAttendance();
      case "leave": return renderLeave();
      case "payroll": return renderPayroll();
      case "assistant": return renderAssistant();
      case "announcements": return renderAnnouncements();
      case "profile": return renderProfile();
      case "settings": return renderSettings();
      case "audit": return renderAudit();
      default: return renderOverview();
    }
  }

  function renderModal() {
    if (modal.type === "invite") return <Modal title="A new teammate is ready" subtitle="Share this one-time sign-up invite securely. It expires in 7 days." onClose={() => setModal(null)}>
      <div className="invite-detail"><span>Name</span><strong>{modal.name}</strong></div><div className="invite-detail"><span>Role</span><strong>{modal.role}</strong></div><div className="invite-detail"><span>Work email</span><strong>{modal.email}</strong></div><div className="invite-password"><span>Sign-up invite code</span><code>{modal.signupCode}</code><p>They choose the matching role, enter their invited email and code, then set their own password.</p></div><div className="modal-actions"><button className="primary-btn" type="button" onClick={() => { navigator.clipboard?.writeText(`Role: ${modal.role}\nEmail: ${modal.email}\nInvite code: ${modal.signupCode}`); setModal(null); }}>Done <Check size={14} /></button></div>
    </Modal>;
    if (modal.type === "change-password") return <Modal title="A password of your own" subtitle="For your security, please replace your temporary password before continuing." busy={busy} onClose={() => { if (!modal.required) setModal(null); }}>
      <form onSubmit={async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); if (values.newPassword !== values.confirmPassword) { notify("Those new passwords don’t match.", "error"); return; } try { await runAction(() => api("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) }), "Your new password is set."); setModal(null); } catch { /* Error appears in the shared toast. */ } }}>
        <Field label="Temporary password" name="currentPassword" type="password" required autoComplete="current-password" />
        <Field label="Your new password" name="newPassword" type="password" required minLength={10} maxLength={128} autoComplete="new-password" hint="Choose at least 10 characters." />
        <Field label="Confirm your new password" name="confirmPassword" type="password" required minLength={10} maxLength={128} autoComplete="new-password" />
        <div className="modal-actions"><button className="primary-btn">{busy ? "Saving…" : "Set my password"} <ArrowRight size={14} /></button></div>
      </form>
    </Modal>;
    const formContent = {
      employee: { title: "Say hello to someone new", subtitle: "Add a teammate and give them a place in your workspace.", button: "Add to the team", inputs: <>
        <Field label="Full name" name="name" required minLength={2} maxLength={80} placeholder="e.g. Amina Noor" />
        <div className="form-grid"><Field label="Work email" name="email" type="email" required /><Field label="Team / department" name="department" required maxLength={60} /></div>
        <div className="form-grid"><Field label="Job title" name="title" required maxLength={80} /><Field label="Monthly salary (PKR)" name="salary" type="number" min="1" required /></div>
      </> },
      hr: { title: "Make room for HR", subtitle: "Create a secure HR account for someone on your team.", button: "Create HR account", inputs: <>
        <Field label="Full name" name="name" required minLength={2} maxLength={80} placeholder="e.g. Maham Ali" />
        <Field label="Work email" name="email" type="email" required maxLength={254} />
      </> },
      leave: { title: "A little time for you", subtitle: "Tell us what you need. We’ll count working days for you.", button: "Send my request", inputs: <>
        <div className="form-group"><label className="form-label" htmlFor="leave-type">Type of leave</label><select className="field" id="leave-type" name="type"><option>Casual</option><option>Annual</option><option>Sick</option><option>Unpaid</option></select></div>
        <div className="form-grid"><Field label="First day" name="start" type="date" required /><Field label="Last day" name="end" type="date" required /></div>
        <div className="form-group"><label className="form-label" htmlFor="leave-reason">A little context</label><textarea className="field" id="leave-reason" name="reason" minLength={3} maxLength={300} required placeholder="Share what you’d like your team to know" /></div>
      </> },
      announcement: { title: "Share a little news", subtitle: "A kind word or useful update helps everyone feel in the loop.", button: "Share with the team", inputs: <>
        <Field label="A little headline" name="title" minLength={3} maxLength={100} required placeholder="What’s happening?" />
        <div className="form-group"><label className="form-label" htmlFor="announcement-body">The details</label><textarea className="field" id="announcement-body" name="body" minLength={3} maxLength={2000} required placeholder="A little more about your update…" /></div>
      </> },
      correction: { title: "A small attendance correction", subtitle: "Tell HR what needs correcting in your attendance record.", button: "Send correction", inputs: <>
        <Field label="Day to correct" name="date" type="date" required />
        <Field label="Correct check-in (optional)" name="checkIn" type="datetime-local" />
        <div className="form-group"><label className="form-label" htmlFor="correction-reason">Why should we change it?</label><textarea className="field" id="correction-reason" name="reason" minLength={5} maxLength={300} required /></div>
      </> },
    }[modal.type];
    if (!formContent) return null;
    return <Modal title={formContent.title} subtitle={formContent.subtitle} busy={busy} onClose={() => !busy && setModal(null)}>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (!event.currentTarget.reportValidity()) return;
        const values = Object.fromEntries(new FormData(event.currentTarget));
        try {
          if (modal.type === "employee") await handleCreateEmployee(values);
          if (modal.type === "hr") await handleCreateHr(values);
          if (modal.type === "leave") {
            if (values.end < values.start) throw new Error("The last day should be on or after the first day.");
            await runAction(() => api("/leave", { method: "POST", body: JSON.stringify(values) }), "Your leave request is on its way. No rushing.");
            setModal(null);
          }
          if (modal.type === "announcement") {
            await runAction(() => api("/announcements", { method: "POST", body: JSON.stringify(values) }), "Your update is ready for the team.");
            setModal(null);
          }
          if (modal.type === "correction") {
            const payload = { date: values.date, reason: values.reason };
            if (values.checkIn) payload.checkIn = new Date(values.checkIn).toISOString();
            await runAction(() => api("/attendance/correction", { method: "POST", body: JSON.stringify(payload) }), "Your correction is ready for HR to review.");
            setModal(null);
          }
        } catch { /* Errors are announced by the shared toast. */ }
      }}>
        {formContent.inputs}
        <div className="modal-actions"><button className="secondary-btn" type="button" disabled={busy} onClick={() => setModal(null)}>Not right now</button><button className="primary-btn" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : null}{busy ? "One moment…" : formContent.button} <ArrowRight size={14} /></button></div>
      </form>
    </Modal>;
  }

  function exportCsv() {
    const rows = [["Name", "Email", "Department", "Job title", "Salary", "Joined", "Status"], ...employeeList.map((employee) => [employee.name, employee.email, employee.department, employee.title, employee.salary, employee.joined, employee.status])];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "hcm-lite-people.csv"; anchor.click();
    URL.revokeObjectURL(url);
    notify("Your team list is on its way.");
  }
}

export default App;
