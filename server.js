import express from "express";
import axios from "axios";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  jidNormalizedUser
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const SESSIONS_DIR = path.resolve("./sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({ level: "info" });

const sessions = new Map();

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const headerKey = req.headers["x-api-key"];
  if (headerKey !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.use(authMiddleware);

function getSessionPath(userId) {
  return path.join(SESSIONS_DIR, String(userId));
}

function getSafeSession(userId) {
  return sessions.get(String(userId));
}

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {})
      }
    });
  } catch (error) {
    logger.error("Erro webhook:", error.message);
  }
}

async function createOrRestoreSession(userId) {
  userId = String(userId);

  if (sessions.has(userId)) return sessions.get(userId);

  const authDir = getSessionPath(userId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["CRM", "Chrome", "1.0"]
  });

  const sessionData = {
    sock,
    status: "pending",
    qrCodeDataUrl: null
  };

  sessions.set(userId, sessionData);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qrCodeDataUrl = await QRCode.toDataURL(qr);
      sessionData.status = "pending";
    }

    if (connection === "open") {
      sessionData.status = "connected";
      sessionData.qrCodeDataUrl = null;
      console.log("✅ WhatsApp conectado:", userId);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;

      sessionData.status = "disconnected";

      if (shouldReconnect) {
        setTimeout(() => {
          sessions.delete(userId);
          createOrRestoreSession(userId);
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const phone = (msg.key.remoteJid || "").replace("@s.whatsapp.net", "");

      const content =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "[mensagem]";

      await postWebhook({
        user_id: userId,
        phone,
        message: content,
        timestamp: new Date().toISOString(),
        direction: "inbound"
      });
    }
  });

  return sessionData;
}

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("55")) return digits;
  return `55${digits}`;
}

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/whatsapp/connect", async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id obrigatório" });
  }

  const session = await createOrRestoreSession(user_id);

  res.json({
    status: session.status,
    qr_code: session.qrCodeDataUrl
  });
});

app.get("/whatsapp/status", (req, res) => {
  const { user_id } = req.query;

  const session = getSafeSession(user_id);

  if (!session) {
    return res.json({ status: "disconnected" });
  }

  res.json({
    status: session.status,
    qr_code: session.qrCodeDataUrl
  });
});

app.post("/whatsapp/send", async (req, res) => {
  const { user_id, phone, message } = req.body;

  const session = getSafeSession(user_id);

  if (!session || session.status !== "connected") {
    return res.status(400).json({ error: "WhatsApp não conectado" });
  }

  const jid = `${normalizePhone(phone)}@s.whatsapp.net`;

  await session.sock.sendMessage(jidNormalizedUser(jid), {
    text: message
  });

  await postWebhook({
    user_id,
    phone,
    message,
    timestamp: new Date().toISOString(),
    direction: "outbound"
  });

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta", PORT);
});
