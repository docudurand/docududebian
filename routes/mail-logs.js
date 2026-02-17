// route admin pour consulter les logs d'emails

import express from "express";
import crypto from "node:crypto";
import { getMailLogs } from "../mailLog.js";

// routeur Express separe
const router = express.Router();

// token admin obligatoire pour acceder aux logs
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

function safeEqual(expected, provided) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(provided || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Recupere le token admin
function extractAdminToken(req) {
  const headerToken = req.headers["x-admin-token"];
  if (headerToken) return String(headerToken).trim();

  const auth = req.headers.authorization;
  if (auth) {
    const value = String(auth).trim();
    if (value.toLowerCase().startsWith("bearer ")) {
      return value.slice(7).trim();
    }
  }

  return "";
}

// Middleware de protection
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "admin_token_not_configured" });
  }
  const token = extractAdminToken(req);
  if (!safeEqual(ADMIN_TOKEN, token)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

// API: liste des logs d'emails
router.get("/api/mail-logs", requireAdmin, async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 200);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(1000, Math.trunc(limitRaw)))
      : 200;
    const q = String(req.query.q || "").slice(0, 300);
    const data = await getMailLogs({ limit, q });
    res.setHeader("Cache-Control", "no-store");
    res.json(data.logs || data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
