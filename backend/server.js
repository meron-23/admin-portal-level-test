const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { URL } = require("node:url");

loadEnvFile();

const PORT = Number(process.env.PORT || 4200);
const PUBLIC_BASE_URL = trimTrailingSlash(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`);
const TEST_APP_URL = process.env.TEST_APP_URL || "http://localhost:3000/onboarding/info";
const DELIVERY_PROVIDER = (process.env.DELIVERY_PROVIDER || "email").toLowerCase();
const EMAIL_DRY_RUN = process.env.EMAIL_DRY_RUN !== "false";
const SMS_DRY_RUN = process.env.SMS_DRY_RUN !== "false";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-admin-secret";
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "data", "invites.json");
const OUTBOX_FILE = path.join(ROOT, "data", "sms-outbox.jsonl");
const EMAIL_OUTBOX_FILE = path.join(ROOT, "data", "email-outbox.eml");

const STATUS = {
  DRAFT: "draft",
  SENT: "sent",
  SEND_FAILED: "send_failed",
  OPENED: "opened",
  COMPLETED: "completed",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Setup CORS headers dynamically
    const origin = req.headers.origin;
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim());
    
    if (origin) {
      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*") || !process.env.ALLOWED_ORIGINS) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cookie, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5000";

    if (req.method === "GET" && ["/", "/login", "/login.html", "/index.html"].includes(url.pathname)) {
      return redirect(res, `${FRONTEND_URL}${url.pathname}`);
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      return await handleLogin(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      return handleLogout(req, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/t/")) {
      return await openInvite(req, res, url.pathname.split("/").pop());
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthenticated(req)) return json(res, 401, { error: "Sign in required" });
      return await handleApi(req, res, url);
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Admin portal backend running at ${PUBLIC_BASE_URL}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      publicBaseUrl: PUBLIC_BASE_URL,
      testAppUrl: TEST_APP_URL,
      deliveryProvider: DELIVERY_PROVIDER,
      emailDryRun: EMAIL_DRY_RUN,
      emailReady: hasEmailConfig(),
      smsDryRun: SMS_DRY_RUN,
      smsReady: hasTwilioConfig(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/invites") {
    return json(res, 200, await readInvites());
  }

  if (req.method === "POST" && url.pathname === "/api/invites") {
    const body = await readJson(req);
    const invite = createInvite(body);
    const invites = await readInvites();
    invites.unshift(invite);
    await writeInvites(invites);
    return json(res, 201, invite);
  }

  if (req.method === "POST" && url.pathname === "/api/invites/send-pending") {
    const invites = await readInvites();
    const updated = [];
    for (const invite of invites) {
      updated.push(invite.status === STATUS.DRAFT || invite.status === STATUS.SEND_FAILED ? await sendMessageForInvite(invite, "invite") : invite);
    }
    await writeInvites(updated);
    return json(res, 200, updated);
  }

  if (req.method === "POST" && url.pathname === "/api/invites/sync-completions") {
    const synced = await syncCompletedAssessments();
    return json(res, 200, synced);
  }

  const match = url.pathname.match(/^\/api\/invites\/([^/]+)\/(send|remind|complete|cancel)$/);
  if (req.method === "POST" && match) {
    const [, id, action] = match;
    const invites = await readInvites();
    const index = invites.findIndex((invite) => invite.id === id);
    if (index === -1) return json(res, 404, { error: "Invite not found" });

    if (action === "send") invites[index] = await sendMessageForInvite(invites[index], "invite");
    if (action === "remind") invites[index] = await sendMessageForInvite(invites[index], "reminder");
    if (action === "complete") invites[index] = markCompleted(invites[index], "Marked completed by admin");
    if (action === "cancel") invites[index] = { ...invites[index], status: "cancelled", updatedAt: now(), lastActivity: "Cancelled by admin" };

    await writeInvites(invites);
    return json(res, 200, invites[index]);
  }

  return json(res, 404, { error: "Not found" });
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = clean(body.email).toLowerCase();
  const password = String(body.password || "");

  if (email !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
    return json(res, 401, { error: "Invalid email or password" });
  }

  const session = createSessionToken();
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": `admin_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleLogout(req, res) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": "admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
  });
  res.end(JSON.stringify({ ok: true }));
}

async function openInvite(req, res, token) {
  const invites = await readInvites();
  const index = invites.findIndex((invite) => invite.token === token);

  if (index === -1) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("This test link is invalid.");
    return;
  }

  const invite = invites[index];
  if (invite.status === "cancelled") {
    res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
    res.end("This test link has been cancelled.");
    return;
  }

  const openedAt = invite.openedAt || now();
  invites[index] = {
    ...invite,
    status: invite.status === STATUS.COMPLETED ? STATUS.COMPLETED : STATUS.OPENED,
    openedAt,
    openCount: (invite.openCount || 0) + 1,
    lastOpenedIp: req.socket.remoteAddress,
    lastActivity: invite.status === STATUS.COMPLETED ? "Opened after completion" : "Opened test link",
    updatedAt: now(),
  };
  await writeInvites(invites);

  const redirectUrl = new URL(TEST_APP_URL);
  redirectUrl.searchParams.set("invite", invite.token);
  if (invite.email) redirectUrl.searchParams.set("email", invite.email);
  if (invite.phone) redirectUrl.searchParams.set("phone", invite.phone);

  res.writeHead(302, { location: redirectUrl.toString() });
  res.end();
}

function createInvite(body) {
  const name = clean(body.name);
  const phone = normalizePhone(body.phone);
  const email = clean(body.email);

  if (!name) throw badRequest("Name is required");
  if (!phone && !email) throw badRequest("Phone number or email is required");
  if (DELIVERY_PROVIDER === "email" && !email) throw badRequest("Email is required for email delivery");

  const createdAt = now();
  const token = crypto.randomBytes(24).toString("base64url");

  return {
    id: crypto.randomUUID(),
    name,
    phone,
    email,
    token,
    status: STATUS.DRAFT,
    inviteUrl: `${PUBLIC_BASE_URL}/t/${token}`,
    sentAt: null,
    sendError: null,
    openedAt: null,
    completedAt: null,
    reminderCount: 0,
    openCount: 0,
    lastActivity: "Invite created",
    createdAt,
    updatedAt: createdAt,
  };
}

async function sendMessageForInvite(invite, type) {
  const message = type === "reminder"
    ? `Reminder: ${invite.name}, please complete your English level test here: ${invite.inviteUrl}`
    : `Hi ${invite.name}, please take your English level test here: ${invite.inviteUrl}`;

  const sentAt = now();

  try {
    if (DELIVERY_PROVIDER === "sms") {
      await sendSms(invite.phone, message);
    } else {
      await sendEmail(invite, type, message);
    }

    const dryRun = DELIVERY_PROVIDER === "sms" ? SMS_DRY_RUN : EMAIL_DRY_RUN;
    const channelLabel = DELIVERY_PROVIDER === "sms" ? "SMS" : "email";
    return {
      ...invite,
      status: invite.status === STATUS.COMPLETED ? STATUS.COMPLETED : STATUS.SENT,
      sentAt: invite.sentAt || sentAt,
      lastReminderAt: type === "reminder" ? sentAt : invite.lastReminderAt || null,
      reminderCount: type === "reminder" ? (invite.reminderCount || 0) + 1 : invite.reminderCount || 0,
      sendError: null,
      lastActivity: dryRun
        ? `${type === "reminder" ? "Reminder" : "Invite"} written to ${channelLabel} dry-run outbox`
        : `${type === "reminder" ? "Reminder" : "Invite"} ${channelLabel} sent`,
      updatedAt: sentAt,
    };
  } catch (error) {
    return {
      ...invite,
      status: STATUS.SEND_FAILED,
      sendError: error.message,
      lastActivity: `${DELIVERY_PROVIDER === "sms" ? "SMS" : "Email"} failed: ${error.message}`,
      updatedAt: sentAt,
    };
  }
}

async function sendEmail(invite, type, textBody) {
  if (!invite.email) {
    throw new Error("Invite has no email address");
  }

  const subject = type === "reminder"
    ? "Reminder: complete your English level test"
    : "Your English level test link";

  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  if (!from) throw new Error("EMAIL_FROM or SMTP_USER is not configured");

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#18212f">
      <p>Hi ${escapeHtmlForEmail(invite.name)},</p>
      <p>${type === "reminder" ? "This is a reminder to complete your English level test." : "Please take your English level test using your private link."}</p>
      <p><a href="${invite.inviteUrl}" style="display:inline-block;background:#1f7a6d;color:#fff;padding:12px 16px;border-radius:6px;text-decoration:none">Open level test</a></p>
      <p>Private link: <br><a href="${invite.inviteUrl}">${invite.inviteUrl}</a></p>
    </div>
  `;

  const email = buildEmail({
    from,
    to: invite.email,
    subject,
    text: textBody,
    html: htmlBody,
  });

  if (EMAIL_DRY_RUN) {
    await appendEmailOutbox(email);
    return;
  }

  if (!hasEmailConfig()) {
    throw new Error("SMTP email settings are not configured");
  }

  await sendSmtp(email, {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  });
}

async function sendSms(to, message) {
  if (SMS_DRY_RUN) {
    await appendOutbox({ to, message, createdAt: now(), mode: "dry_run" });
    return;
  }

  if (!hasTwilioConfig()) {
    throw new Error("Twilio credentials are not configured");
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = normalizePhone(process.env.TWILIO_FROM_NUMBER);
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const body = new URLSearchParams({ To: normalizePhone(to), From: from, Body: message });

  let response;
  try {
    response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (error) {
    const cause = error.cause ? ` (${error.cause.code || error.cause.message})` : "";
    throw new Error(`Twilio request failed: ${error.message}${cause}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio returned ${response.status}: ${text.slice(0, 180)}`);
  }
}

async function syncCompletedAssessments() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not configured. Returning existing invites for local development.");
    return await readInvites();
  }

  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    throw badRequest("The pg package is required for completion sync");
  }

  const invites = await readInvites();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    for (let i = 0; i < invites.length; i += 1) {
      const invite = invites[i];
      if (invite.status === STATUS.COMPLETED) continue;

      const result = await client.query(
        `select s.id, s."completedAt", s."finalCefrLevel", s."totalScore"
         from "AssessmentSession" s
         join "Student" st on st.id = s."studentId"
         where s.status = 'COMPLETED'
           and (st."phoneNumber" = $1 or st.email = $2)
         order by s."completedAt" desc
         limit 1`,
        [invite.phone, invite.email || ""],
      );

      if (result.rows[0]) {
        invites[i] = markCompleted(invite, "Synced from completed assessment", result.rows[0]);
      }
    }
  } finally {
    await client.end();
  }

  await writeInvites(invites);
  return invites;
}

function markCompleted(invite, activity, session = {}) {
  return {
    ...invite,
    status: STATUS.COMPLETED,
    completedAt: session.completedAt || invite.completedAt || now(),
    assessmentSessionId: session.id || invite.assessmentSessionId || null,
    cefrLevel: session.finalCefrLevel || invite.cefrLevel || null,
    totalScore: session.totalScore ?? invite.totalScore ?? null,
    lastActivity: activity,
    updatedAt: now(),
  };
}

async function readInvites() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  return JSON.parse(raw || "[]");
}

async function writeInvites(invites) {
  await ensureDataFile();
  await fs.writeFile(DATA_FILE, `${JSON.stringify(invites, null, 2)}\n`);
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, "[]\n");
  }
}

async function appendOutbox(entry) {
  await fs.mkdir(path.dirname(OUTBOX_FILE), { recursive: true });
  await fs.appendFile(OUTBOX_FILE, `${JSON.stringify(entry)}\n`);
}

async function appendEmailOutbox(email) {
  await fs.mkdir(path.dirname(EMAIL_OUTBOX_FILE), { recursive: true });
  await fs.appendFile(EMAIL_OUTBOX_FILE, `${email}\n\n---\n\n`);
}

function buildEmail({ from, to, subject, text, html }) {
  const boundary = `boundary_${crypto.randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  return `${headers.join("\r\n")}\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n\r\n` +
    `--${boundary}--\r\n`;
}

async function sendSmtp(email, options) {
  const socket = await connectSmtp(options);
  let upgradedSocket = socket;

  try {
    await expectSmtp(upgradedSocket, 220);
    await smtpCommand(upgradedSocket, `EHLO ${smtpHostName()}`, 250);

    if (!options.secure) {
      await smtpCommand(upgradedSocket, "STARTTLS", 220);
      upgradedSocket = tls.connect({ socket: upgradedSocket, servername: options.host });
      await expectSmtp(upgradedSocket, 220, true);
      await smtpCommand(upgradedSocket, `EHLO ${smtpHostName()}`, 250);
    }

    await smtpCommand(upgradedSocket, "AUTH LOGIN", 334);
    await smtpCommand(upgradedSocket, Buffer.from(options.user).toString("base64"), 334);
    await smtpCommand(upgradedSocket, Buffer.from(options.pass).toString("base64"), 235);
    await smtpCommand(upgradedSocket, `MAIL FROM:<${addressOnly(process.env.EMAIL_FROM || options.user)}>`, 250);
    await smtpCommand(upgradedSocket, `RCPT TO:<${addressOnly(extractHeader(email, "To"))}>`, [250, 251]);
    await smtpCommand(upgradedSocket, "DATA", 354);
    await smtpCommand(upgradedSocket, `${email.replace(/\r?\n\./g, "\r\n..")}\r\n.`, 250);
    await smtpCommand(upgradedSocket, "QUIT", 221);
  } finally {
    upgradedSocket.end();
  }
}

function connectSmtp(options) {
  return new Promise((resolve, reject) => {
    const connectOptions = { host: options.host, port: options.port };
    const socket = options.secure ? tls.connect(connectOptions) : net.connect(connectOptions);
    socket.setTimeout(20000);
    socket.once("connect", () => resolve(socket));
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("SMTP connection timed out")));
  });
}

function expectSmtp(socket, expected, skipRead = false) {
  if (skipRead) return Promise.resolve("");
  return readSmtp(socket).then((line) => {
    assertSmtp(line, expected);
    return line;
  });
}

async function smtpCommand(socket, command, expected) {
  socket.write(`${command}\r\n`);
  const response = await readSmtp(socket);
  assertSmtp(response, expected);
  return response;
}

function readSmtp(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("SMTP response timed out"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function assertSmtp(response, expected) {
  const code = Number(response.slice(0, 3));
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(code)) {
    throw new Error("SMTP returned " + code + ": " + response.trim().slice(0, 220));
  }
}



async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function clean(value) {
  return String(value || "").trim();
}

function normalizePhone(value) {
  return clean(value).replace(/\s+/g, "");
}

function now() {
  return new Date().toISOString();
}

function hasTwilioConfig() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

function hasEmailConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function loadEnvFile() {
  const file = path.join(__dirname, ".env");
  try {
    const raw = require("node:fs").readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const session = cookies.admin_session;
  if (!session) return false;

  const [payload, signature] = session.split(".");
  if (!payload || !signature) return false;

  const expected = sign(payload);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > Date.now();
  } catch {
    return false;
  }
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({
    email: ADMIN_EMAIL,
    exp: Date.now() + 8 * 60 * 60 * 1000,
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function parseCookies(header) {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function encodeHeader(value) {
  return String(value).replace(/\r?\n/g, " ");
}

function extractHeader(email, header) {
  const line = email.split(/\r?\n/).find((item) => item.toLowerCase().startsWith(header.toLowerCase() + ":"));
  return line ? line.slice(header.length + 1).trim() : "";
}

function addressOnly(value) {
  const match = String(value).match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function smtpHostName() {
  return "localhost";
}

function escapeHtmlForEmail(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
