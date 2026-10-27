# HCM Lite

A responsive React application with a Node.js/Express API for a small human-capital-management workflow. The dashboard, motion, and mobile layout follow the Saylani Hackathon HCM Lite brief.

## Run locally

Requirements: Node.js 22.13 or newer and npm.

```powershell
npm install
npm run dev
```

Open `http://localhost:3000/HCM`. Vite serves the React app on port 3000 and proxies `/api` requests to the Express API on port 3001. On a fresh database, create the company and initial administrator; on later visits, sign in with that administrator's credentials. Admins and HR users create HR and employee accounts from inside the workspace. Use a password with at least 12 characters.

### Share a temporary link with other devices

Install Cloudflare Tunnel (`cloudflared`) and make sure `cloudflared --version` works in PowerShell. On Windows, you can install it with `winget install --id Cloudflare.cloudflared`. Then start the app and a temporary HTTPS tunnel together:

```powershell
npm run dev:share
```

Keep that terminal open and use the `https://….trycloudflare.com/HCM` URL printed by `cloudflared` on another device. The app also remains available locally at `http://localhost:3000/HCM`. The temporary URL changes each time and stops working when the command ends. This exposes the development app to anyone who has the link; keep account passwords private and do not use real employee/payroll data over a temporary share link. Google sign-in may require adding the current tunnel origin to the Google OAuth client's Authorized JavaScript origins; because Quick Tunnel URLs change, password sign-in is the reliable option. Use a named Cloudflare Tunnel and stable domain for continued sharing.

The production build is served by the API process:

```powershell
npm run build
npm start
```

### Deploy the full app on Render

The app needs a Node web service and persistent storage for SQLite. Deploy the repository on Render using the included `render.yaml` Blueprint. It creates a paid Starter web service and a 1 GB persistent disk; Render's free web services do not support persistent disks, so do not remove the disk if you want user accounts, conversations, and records to survive restarts and deploys. Review current Render pricing before creating the service.

After the Blueprint creates the service, open its Environment settings and set:

- `APP_ORIGIN` to the service's public HTTPS URL (for example, `https://hcm-lite.onrender.com`).
- `OAUTH_CALLBACK_BASE_URL` to that same public HTTPS origin.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a production GitHub OAuth App. Set its callback URL to `<APP_ORIGIN>/api/ai/copilot/callback`. A GitHub OAuth App has one callback URL; use a separate OAuth App for local development if needed.
- `GOOGLE_CLIENT_ID` is optional. If enabled, add the public `APP_ORIGIN` to the Google OAuth client's authorized JavaScript origins.

Keep all secret values in Render's Environment settings, never in the repository. Save changes and wait for the service deploy to finish, then open `<APP_ORIGIN>/HCM` and create the first Admin account. A fresh hosted service has its own empty database; local accounts and data are not uploaded.

Local ComfyUI at `127.0.0.1:8188` is not reachable by the hosted server. Image generation/editing therefore works only when ComfyUI is available to the server at its configured `COMFYUI_URL`; do not expose an unauthenticated ComfyUI port publicly. GitHub Copilot and Google OAuth also require the production callback/origin settings above.

Keep the existing `.env` file; do not create another one. Set a stable, randomly generated `JWT_SECRET`, `APP_ORIGIN=http://localhost:3000`, `OAUTH_CALLBACK_BASE_URL=http://localhost:3001`, and the `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a GitHub OAuth App. Register `http://localhost:3001/api/ai/copilot/callback` as the OAuth callback URL, restart `npm run dev`, then each user connects their own GitHub Copilot account in HCM Settings. A GitHub Copilot subscription or eligible Copilot access is required for each linked account. GitHub tokens are encrypted at rest using `JWT_SECRET`, and each ordinary chat uses only the requesting user's token. Copilot sessions have no tools or filesystem access and receive only role-scoped workspace data. The Copilot callback is localhost-only; temporary Cloudflare links cannot complete this OAuth flow. Image generation and editing use the local ComfyUI server without an external image API: install ComfyUI and a compatible checkpoint model on the same PC, start its local server (default `http://127.0.0.1:8188`), and optionally set `COMFYUI_URL` and `COMFYUI_CHECKPOINT` in the existing `.env` file. Generation requires a running ComfyUI server and downloaded model; performance depends on the PC and model, and integrated graphics/CPU-only machines may be very slow. Uploaded edit images are sent to the local ComfyUI service and may remain in its input/output folders. The old `AI_API_KEY`, `AI_MODEL`, and `AI_IMAGE_MODEL` settings are not used by image generation.

Google sign-in uses the free Google Identity Services web flow and is available for sign-in (not account sign-up). In Google Cloud Console, configure the OAuth consent screen, create an OAuth client ID of type **Web application**, and add `http://localhost:3000` under **Authorized JavaScript origins** (add the exact HTTPS origin of your Cloudflare tunnel or deployed site too; do not include `/HCM`). Put the resulting client ID in the server `.env` file as `GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com`, then restart the API. No Google client secret is needed for this popup-based flow. The API verifies the ID token and sign-in nonce. An existing account can link its verified Google email on first Google sign-in. The first Admin is created during workspace setup, then can use Google sign-in with that same verified email.

GitHub OAuth is used to connect each user's Copilot account and may also be used for GitHub sign-in. For local development, configure the GitHub OAuth App callback as `http://localhost:3001/api/ai/copilot/callback`; the redirect host must match the existing app callback base. The browser origin for this app is still `http://localhost:3000`; the callback points to the API. For GitHub sign-up, users must provide their mobile number, select HR or Employee, and provide their invited work email and one-time invite code; the provider-returned email must match. GitHub sign-in requires a verified primary email. Existing accounts can link GitHub when its verified email matches the account.

Fictional sample data is opt-in: set `ENABLE_DEMO_DATA=true`, restart the server, then use the Admin's Settings page to load it into a workspace with an empty employee directory. The sample records are persistent and the app does not provide an automatic undo.

## Included workflows

- First-run company and administrator setup; bcrypt password hashes and HTTP-only session cookies. The initial company setup creates the Admin; later Admin/HR/Employee sign-up requires a matching one-time HR/Employee invitation code, while creating additional Admin accounts is not available through public sign-up. HR/Employee sign-up requires a mobile number for monthly billing.
- Monthly HR/Employee access fee with a default of PKR 1,000, starting November 21, 2026. Until then, and through the 20th of each month, HR and Employees can use the workspace without a payment. After the 20th, staff request a monthly payment ID, transfer the fee to the EasyPaisa receiving number set by the Admin, and submit their transaction reference; the Admin verifies the transaction before access is unlocked. Payment IDs are valid for seven days and can be renewed after expiry. This is a manual verification flow, not an automatic EasyPaisa merchant checkout.
- Admin, HR, and employee roles with API-side permission checks and employee-owned data scoping. Admin and HR can review pending leave requests and send a written reply; employees can update their profile and change their password from Settings.
- HR/Employee invitations with role-bound, one-time sign-up codes that expire after seven days; invited teammates set their own password. CSV-created accounts continue to use one-time temporary passwords.
- Employee directory, server-stamped check-in/check-out, leave balances and approval, payroll drafts and Admin-only finalization, announcements, editable personal contact details, audit log, and a GitHub Copilot-powered assistant. Each user links their own GitHub account in Settings; the backend encrypts that user's OAuth token in SQLite, and chat requests only use the requesting account's token. Copilot conversation threads, messages, and uploaded attachments are stored in SQLite, scoped to the owning user, and removed when that conversation is deleted. Users can attach up to three PNG/JPEG/WebP/GIF images or PDF, text, CSV, JSON, DOCX, XLSX, and PPTX files per message (3 MB each; 6 MB total); attachments are sent to GitHub Copilot for analysis. The Copilot SDK's experimental native image-generation capability is enabled for creating/editing images, and returned images are saved in that user's chat. Generation depends on GitHub's image-model eligibility, service policy, and quota; it cannot be guaranteed for every account. Temporary copies used by the SDK are removed after each request. The SDK runs without filesystem access and receives only role-scoped workspace data. Employee face attendance is designed for the office kiosk at `http://localhost:3000`: employees consent and enroll during invited sign-up, and three consecutive local face matches are required before the attendance UI submits a check-in/out for the signed-in account. Existing employees can enroll on the kiosk on their first attendance attempt. Only a mathematical face template is kept in that browser's IndexedDB; camera frames and templates are not uploaded. The template is not encrypted by this app, so restrict access to the kiosk's browser profile. The attendance record itself is saved on the server with the employee's name. Other devices, browser profiles, localhost aliases, and temporary Cloudflare origins have separate local storage; they cannot reuse the kiosk template. Face matching is client-side and is not liveness detection or server-verifiable identity proof, so a photo may spoof it and a direct API client can bypass the UI check. Keep the kiosk physically controlled and do not treat this prototype as a high-assurance biometric security system.
- SQLite persistence in `data/hcm-lite.sqlite` by default. Set `DATABASE_PATH` to move it. MongoDB is not the active application store yet; the current API depends on SQLite queries and transactions, so setting a MongoDB URI alone would not migrate or persist workspace data in MongoDB.

Workspace records, Copilot chat history, and uploaded chat files are saved in SQLite and survive a browser refresh. The database defaults to the project-root `data/hcm-lite.sqlite` path, regardless of the directory from which the server is launched; set `DATABASE_PATH` to choose another location. The browser remembers each signed-in user's last workspace page and selected chat. Theme and face-enrollment templates remain browser-local. Camera access requires user permission and localhost or HTTPS. Before exposing the prototype to the public internet, configure HTTPS and a production secret, add database backups and a real organization-specific authorization/recovery process, and review payroll, tax, privacy, and legal requirements. GPS attendance and an email-delivery service are not implemented.

## Verify

```powershell
npm test
npm run build
```
