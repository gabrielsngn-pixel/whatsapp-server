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
  makeInMemoryStore,
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

// Estrutura em memória para MVP.
// Em produção, você deveria persistir isso em banco/redis.
const sessions = new Map();
/*
sessions[userId] = {
  sock,
  store,
  status: "pending" | "connected" | "disconnected",
  qrCodeDataUrl: string | null,
  lastConnectionUpdate: Date | null
}
*/

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
      },
      timeout: 15000
    });
  } catch (error) {
    logger.error(
      {
        msg: "Erro ao enviar webhook",
        error: error?.response?.data || error.message
      }
    );
  }
}

async function createOrRestoreSession(userId) {
  userId = String(userId);

  const existing = sessions.get(userId);
  if (existing?.sock) {
    return existing;
  }

  const authDir = getSessionPath(userId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const store = makeInMemoryStore({ logger });
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["Loft CRM", "Chrome", "1.0.0"],
    syncFullHistory: false
  });

  store.bind(sock.ev);

  const sessionData = {
    sock,
    store,
    status: "pending",
    qrCodeDataUrl: null,
    lastConnectionUpdate: null
  };

  sessions.set(userId, sessionData);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const current = sessions.get(userId);
    if (!current) return;

    current.lastConnectionUpdate = new Date();

    if (qr) {
      try {
        current.qrCodeDataUrl = await QRCode.toDataURL(qr);
        current.status = "pending";
      } catch (err) {
        logger.error({ msg: "Erro gerando QR DataURL", err: err.message });
      }
    }

    if (connection === "open") {
      current.status = "connected";
      current.qrCodeDataUrl = null;
      logger.info({ msg: `Sessão conectada para user_id=${userId}` });
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : undefined;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({
        msg: `Sessão fechada para user_id=${userId}`,
        statusCode,
        shouldReconnect
      });

      current.status = "disconnected";

      if (shouldReconnect) {
        // pequena espera pra reconectar
        setTimeout(() => {
          sessions.delete(userId);
          createOrRestoreSession(userId).catch((err) => {
            logger.error({
              msg: `Erro ao reconectar user_id=${userId}`,
              err: err.message
            });
          });
        }, 3000);
      } else {
        // logout real: apaga sessão local
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (err) {
          logger.error({
            msg: `Erro removendo sessão local user_id=${userId}`,
            err: err.message
          });
        }
        sessions.delete(userId);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid?.includes("@g.us")) continue; // ignora grupo no MVP

        const phone = (msg.key.remoteJid || "").replace("@s.whatsapp.net", "");
        const content =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          "[mensagem sem texto]";

        await postWebhook({
          user_id: userId,
          phone,
          message: content,
          timestamp: new Date().toISOString(),
          direction: "inbound"
        });
      } catch (err) {
        logger.error({
          msg: "Erro processando mensagem recebida",
          err: err.message
        });
      }
    }
  });

  return sessionData;
}

function normalizePhoneBR(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;

  // Se já veio com DDI, mantém
  if (digits.startsWith("55")) return digits;

  // Se veio sem DDI, assume Brasil
  return `55${digits}`;
}

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "whatsapp-server-mvp" });
});

app.post("/whatsapp/connect", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: "user_id é obrigatório" });
    }

    const session = await createOrRestoreSession(user_id);

    return res.json({
      user_id: String(user_id),
      status: session.status,
      qr_code: session.qrCodeDataUrl
    });
  } catch (error) {
    logger.error({ msg: "Erro em /whatsapp/connect", error: error.message });
    return res.status(500).json({ error: "Erro ao conectar WhatsApp" });
  }
});

app.get("/whatsapp/status", async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id é obrigatório" });
    }

    const session = getSafeSession(user_id);

    if (!session) {
      return res.json({
        user_id: String(user_id),
        status: "disconnected",
        qr_code: null
      });
    }

    return res.json({
      user_id: String(user_id),
      status: session.status,
      qr_code: session.qrCodeDataUrl,
      last_update: session.lastConnectionUpdate
    });
  } catch (error) {
    logger.error({ msg: "Erro em /whatsapp/status", error: error.message });
    return res.status(500).json({ error: "Erro ao consultar status" });
  }
});

app.post("/whatsapp/send", async (req, res) => {
  try {
    const { user_id, phone, message } = req.body;

    if (!user_id || !phone || !message) {
      return res
        .status(400)
        .json({ error: "user_id, phone e message são obrigatórios" });
    }

    const session = getSafeSession(user_id);
    if (!session?.sock) {
      return res.status(400).json({ error: "Sessão não inicializada" });
    }

    if (session.status !== "connected") {
      return res.status(400).json({ error: "WhatsApp não está conectado" });
    }

    const normalized = normalizePhoneBR(phone);
    const jid = jidNormalizedUser(`${normalized}@s.whatsapp.net`);

    await session.sock.sendMessage(jid, { text: message });

    // Opcional: também envia webhook de outbound para o Lovable salvar
    await postWebhook({
      user_id: String(user_id),
      phone: normalized,
      message,
      timestamp: new Date().toISOString(),
      direction: "outbound"
    });

    return res.json({
      ok: true,
      user_id: String(user_id),
      phone: normalized,
      message
    });
  } catch (error) {
    logger.error({ msg: "Erro em /whatsapp/send", error: error.message });
    return res.status(500).json({ error: "Erro ao enviar mensagem" });
  }
});

app.post("/whatsapp/logout", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: "user_id é obrigatório" });
    }

    const session = getSafeSession(user_id);
    if (session?.sock) {
      try {
        await session.sock.logout();
      } catch (_) {
        // ignora erro de logout
      }
    }

    const authDir = getSessionPath(user_id);
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
    } catch (_) {}

    sessions.delete(String(user_id));

    return res.json({ ok: true, user_id: String(user_id) });
  } catch (error) {
    logger.error({ msg: "Erro em /whatsapp/logout", error: error.message });
    return res.status(500).json({ error: "Erro ao deslogar sessão" });
  }
});

app.listen(PORT, () => {
  logger.info(`Servidor rodando na porta ${PORT}`);
});