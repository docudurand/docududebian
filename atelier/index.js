// Serveur pour le module atelier avec support JSON/FTP
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import apiRoutes from "./atelier-api-routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const router = express.Router();

// Montage des routes API
router.use(apiRoutes);

// Middleware pour parser le JSON
router.use(express.json());

// Route pour exposer la config
router.get("/config.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const PASS_STE = process.env.ATELIER_SUIVI_PASS_STE || "";
  const PASS_BG = process.env.ATELIER_SUIVI_PASS_BG || "";
  const PASS_LIMITED = process.env.ATELIER_SUIVI_PASS_LIMITED || "";
  const PASS_CHASSE = process.env.ATELIER_SUIVI_PASS_CHASSE || "";
  const PASS_ADMIN = process.env.ATELIER_SUIVI_PASS_ADMIN || "";
  const SUIVI_ADMIN = process.env.ATELIER_SUIVI_ADMIN || "";
  const BASE_URL = process.env.BASE_URL || "";
  const GS_URL = BASE_URL ? `${BASE_URL}/atelier/api/config` : "/atelier/api/config";

  res.send(
    `window.__ATELIER_CFG = {
      ATELIER_SUIVI_PASS_STE: ${JSON.stringify(PASS_STE)},
      ATELIER_SUIVI_PASS_BG: ${JSON.stringify(PASS_BG)},
      ATELIER_SUIVI_PASS_LIMITED: ${JSON.stringify(PASS_LIMITED)},
      ATELIER_SUIVI_PASS_CHASSE: ${JSON.stringify(PASS_CHASSE)},
      ATELIER_SUIVI_PASS_ADMIN: ${JSON.stringify(PASS_ADMIN)},
      ATELIER_SUIVI_ADMIN: ${JSON.stringify(SUIVI_ADMIN)},
      GS_URL: ${JSON.stringify(GS_URL)}
    };`
  );
});

// Dossier de fichiers statiques
const publicDir = path.join(__dirname, "public");

// Pages statiques
router.use(express.static(publicDir, {
  extensions: ["html", "htm"],
  index: false,
  setHeaders: (res, p) => {
    if (p.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

// Route pour générer les QR codes
router.get("/qr/:no", async (req, res) => {
  try {
    const caseNo = req.params.no;
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const validationUrl = `${baseUrl}/atelier/validation?no=${caseNo}`;
    
    // Générer le QR code
    const qrDataUrl = await QRCode.toDataURL(validationUrl, {
      errorCorrectionLevel: "M",
      width: 300,
      margin: 2
    });
    
    // Retourner l'image base64
    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    const imgBuffer = Buffer.from(base64Data, "base64");
    
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(imgBuffer);
  } catch (error) {
    console.error("Erreur génération QR code:", error);
    res.status(500).send("Erreur lors de la génération du QR code");
  }
});

// Page validation
router.get("/validation", (_req, res) => {
  const f = path.join(publicDir, "validation.html");
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).type("text").send("validation.html introuvable.");
});

// Page principale
router.get("/", (_req, res) => {
  const f = path.join(publicDir, "index.html");
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).type("text").send("atelier/public/index.html introuvable.");
});

router.get("/healthz", (_req, res) => res.type("text").send("ok"));

export default router;
