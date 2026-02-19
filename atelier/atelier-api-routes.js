// API Routes pour le module atelier avec données JSON/FTP
import express from "express";
import FTPDataManager from "./ftp-data-manager.js";
import emailSender from "./email-sender.js";

const router = express.Router();
const dataManager = new FTPDataManager();

// Middleware pour parser le JSON
router.use(express.json());

// POST /api/print-html - Génère la page d'aperçu d'impression
// POST /api/print-html - Génère la page d'aperçu d'impression (VERSION EXACTE)
router.post("/api/print-html", (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload || "{}");
    const header = payload.header || {};
    const meta = payload.meta || {};
    const commentaires = payload.commentaires || "";
    const culasse = payload.culasse || null;
    const injecteur = payload.injecteur || null;
    const no = String(payload.no || "").padStart(5, "0");
    
    const service = header.service || "";
    const magasinDemande = header.magasin || "";
    
    // Mapping service → magasin responsable
    function getMagasinForService(serviceName) {
      const serviceKey = String(serviceName || "").trim().toUpperCase();
      
      const mapping = {
        "RECTIFICATION CULASSE": "ST EGREVE",
        "RECTIFICATION VILEBREQUIN": "ST EGREVE",
        "RECTIFICATION DES VOLANTS MOTEUR": "CHASSE-SUR-RHONE",
        "REGARNISSAGES MACHOIRES": "CHASSE-SUR-RHONE",
        "CONTRÔLE INJECTION DIESEL": "ST EGREVE",
        "CONTROLE INJECTION DIESEL": "ST EGREVE",
        "CONTRÔLE INJECTION ESSENCE": "ST EGREVE",
        "CONTROLE INJECTION ESSENCE": "ST EGREVE",
        "ARBRE DE TRANSMISSION": "BOURGOIN"
      };
      
      return mapping[serviceKey] || magasinDemande.toUpperCase();
    }
    
    const magasinService = getMagasinForService(service);
    
    // Base URL pour le QR code
    const baseUrl = process.env.BASE_URL || "";
    const qrUrl = `${baseUrl}/atelier/qr/${no}`;
    
    // Générer le HTML d'impression EXACT
    const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Service Atelier - Demande</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      padding: 40px;
      max-width: 800px;
      margin: 0 auto;
      background: white;
      color: #333;
      line-height: 1.5;
      font-size: 14px;
    }
    
    /* Header avec logo */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 25px;
      padding-bottom: 15px;
      border-bottom: 3px solid #003d7a;
    }
    .logo-section {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .logo-img {
      width: 100px;
      height: auto;
    }
    .logo-text {
      font-size: 10px;
      color: #666;
      font-weight: 500;
    }
    .title-section {
      text-align: right;
    }
    .title-location {
      font-size: 28px;
      font-weight: 900;
      color: #003d7a;
      letter-spacing: 1.5px;
      margin-bottom: 3px;
    }
    .title-service {
      font-size: 18px;
      font-weight: 700;
      color: #003d7a;
      margin-bottom: 2px;
    }
    .title-dossier {
      font-size: 13px;
      color: #666;
    }
    
    /* Sections */
    .section {
      margin-bottom: 22px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 700;
      color: #003d7a;
      margin-bottom: 12px;
      padding-bottom: 4px;
    }
    
    /* Grille d'informations à 2 colonnes */
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 25px;
    }
    .info-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .info-label {
      font-size: 11px;
      font-weight: 700;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .info-value {
      font-size: 14px;
      color: #000;
      font-weight: 500;
    }
    
    /* Liste des opérations */
    .operations-title {
      font-size: 14px;
      font-weight: 700;
      color: #003d7a;
      margin-bottom: 10px;
      margin-top: 14px;
    }
    .operations-list {
      list-style: none;
      padding-left: 0;
    }
    .operations-list li {
      padding: 5px 0 5px 14px;
      position: relative;
      font-size: 14px;
      line-height: 1.5;
    }
    .operations-list li:before {
      content: "•";
      position: absolute;
      left: 0;
      color: #003d7a;
      font-weight: bold;
      font-size: 16px;
    }
    
    /* Pièces à fournir */
    .pieces-text {
      font-size: 13px;
      color: #666;
      font-style: italic;
    }
    
    /* Commentaires */
    .comment-box {
      border: 1px solid #ddd;
      padding: 12px;
      background: #fafafa;
      font-size: 13px;
      white-space: pre-wrap;
      min-height: 80px;
      border-radius: 3px;
    }
    
    /* QR Code section */
    .qr-section {
      margin-top: 30px;
      padding-top: 18px;
      border-top: 2px dashed #ccc;
    }
    .qr-title {
      font-size: 14px;
      font-weight: 700;
      color: #003d7a;
      margin-bottom: 8px;
    }
    .qr-text {
      font-size: 11px;
      color: #666;
      margin-bottom: 10px;
    }
    .qr-image {
      width: 160px;
      height: 160px;
      border: 1px solid #ddd;
      padding: 5px;
      background: white;
    }
    
    /* Impression */
    @media print {
      body { padding: 20px; }
      .no-print { display: none !important; }
    }
    
    @page {
      margin: 15mm;
    }
  </style>
  <script>
    // Déclencher l'impression automatiquement au chargement
    window.addEventListener('load', function() {
      setTimeout(function() {
        window.print();
      }, 500);
    });
  </script>
</head>
<body>
  <!-- Header avec logo Durand -->
  <div class="header">
    <div class="logo-section">
      <img src="https://raw.githubusercontent.com/docudurand/docudurpho/main/logodurand.png" alt="Logo Durand" class="logo-img" />
      <div class="logo-text">pièces automobile et services</div>
    </div>
    <div class="title-section">
      <div class="title-location">${magasinService}</div>
      <div class="title-service">${service}</div>
      <div class="title-dossier">Dossier n° ${no}</div>
    </div>
  </div>
  
  <!-- Informations client -->
  <div class="section">
    <div class="section-title">Informations client</div>
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">Nom du client</div>
        <div class="info-value">${header.client || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">N° de compte client</div>
        <div class="info-value">${header.compte || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Téléphone client</div>
        <div class="info-value">${header.telephone || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Adresse mail magasinier/réceptionnaire</div>
        <div class="info-value">${header.email || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Marque/Modèle</div>
        <div class="info-value">${header.vehicule || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Immatriculation</div>
        <div class="info-value">${header.immat || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Magasin d'envoi</div>
        <div class="info-value">${magasinDemande}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Date de la demande</div>
        <div class="info-value">${header.dateDemande || ""}</div>
      </div>
    </div>
  </div>
  


  ${culasse ? `
  <!-- Bloc Culasse -->
  <div class="section">
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">VL / PL</div>
        <div class="info-value">${culasse.segment || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Cylindre</div>
        <div class="info-value">${culasse.cylindre || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Soupapes</div>
        <div class="info-value">${culasse.soupapes || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Carburant</div>
        <div class="info-value">${culasse.carburant || ""}</div>
      </div>
    </div>

    ${(culasse.operations && culasse.operations.length) ? `
      <div style="margin-top:14px; font-weight:700; color:#003d7a;">Opérations</div>
      <ul style="margin:8px 0 0 18px;">
        ${culasse.operations.map(op => `
          <li style="margin:6px 0;">
            <strong>${op.libelle || op.ligne || ""}</strong>
            ${(op.references && op.references.length) ? `
              <ul style="margin:6px 0 0 18px;">
                ${op.references.map(r => `
                  <li>
                    <strong>${r.reference || ""}</strong>${r.libelleRef ? " – " + r.libelleRef : ""}${(r.prixHT !== null && r.prixHT !== undefined && r.prixHT !== "") ? " (" + r.prixHT + " € HT)" : ""}
                  </li>
                `).join("")}
              </ul>
            ` : ""}
          </li>
        `).join("")}
      </ul>
    ` : ""}

    ${(culasse.piecesAFournir && culasse.piecesAFournir.length) ? `
      <div style="margin-top:14px; font-weight:700; color:#003d7a;">Pièces à fournir</div>
      <ul style="margin:8px 0 0 18px;">
        ${culasse.piecesAFournir.map(p => `<li style="margin:4px 0;">${p}</li>`).join("")}
      </ul>
    ` : ""}
  </div>
  ` : ""}
  ${injecteur ? `
  <!-- Détails Contrôle injection -->
  <div class="section">
    <div class="section-title">Détails Contrôle injection</div>
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">Type</div>
        <div class="info-value">${injecteur.type || ""}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Nombre d'injecteurs</div>
        <div class="info-value">${injecteur.nombre || ""}</div>
      </div>
    </div>
  </div>
  ` : ''}
  
  ${commentaires ? `
  <!-- Commentaires -->
  <div class="section">
    <div class="section-title">Commentaires</div>
    <div class="comment-box">${commentaires}</div>
  </div>
  ` : ''}
  
  <!-- QR Code de validation (UN SEUL) -->
  <div id="qr-validation" class="qr-section">
    <div class="qr-title">Validation de la réception de la pièce</div>
    <div class="qr-text">Scannez ce QR Code pour valider la réception de la pièce.</div>
    <img src="${qrUrl}" alt="QR Code" class="qr-image" />
  </div>
</body>
</html>
    `;
    
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    console.error("Erreur POST /api/print-html:", error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Erreur</title></head>
      <body>
        <h1>Erreur lors de la génération de l'aperçu</h1>
        <p>${error.message}</p>
      </body>
      </html>
    `);
  }
});

// POST /api/submit - Route pour le formulaire de demande (compatibilité avec l'ancien système)
router.post("/api/submit", async (req, res) => {
  try {
    const { payload } = req.body;
    
    if (!payload) {
      return res.status(400).json({
        ok: false,
        error: "Payload manquant"
      });
    }
    
    // Extraire les données du payload
    const header = payload.header || {};
    const snapshot = payload;
    
    // Créer le nouveau dossier
    const caseData = {
      magasin: header.magasin || "",
      compte: header.compte || "",
      client: header.client || "",
      service: header.service || "",
      demandeDate: header.dateDemande || new Date().toISOString().split('T')[0],
      status: "Demande envoyé",
      estimation: null,
      snapshot: snapshot
    };
    
    const newCase = await dataManager.addCase(caseData);
    
    // Envoyer l'email de notification au responsable du service
    try {
      const emailResult = await emailSender.sendNewRequestEmail(newCase);
      if (emailResult.sent) {
        console.log(`[ATELIER] Email envoyé à ${emailResult.to} pour le dossier ${newCase.no}`);
      } else {
        console.warn(`[ATELIER] Email non envoyé pour le dossier ${newCase.no}: ${emailResult.reason}`);
      }
    } catch (emailError) {
      console.error(`[ATELIER] Erreur envoi email dossier ${newCase.no}:`, emailError);
    }
    
    res.json({
      ok: true,
      no: newCase.no,
      message: "Demande enregistrée avec succès"
    });
  } catch (error) {
    console.error("Erreur POST /api/submit:", error);
    res.status(500).json({
      ok: false,
      error: "Erreur lors de l'enregistrement de la demande"
    });
  }
});

// GET /api/config - Route pour charger les lignes et règles (compatibilité)
router.get("/api/config", async (req, res) => {
  try {
    const type = req.query.type;
    
    if (type === 'atelier') {
      const lignes = await dataManager.getLignes();
      const regles = await dataManager.getReglesRef();
      
      res.json({
        lignes: lignes,
        regles: regles
      });
    } else {
      res.json({
        lignes: [],
        regles: []
      });
    }
  } catch (error) {
    console.error("Erreur GET /api/config:", error);
    res.status(500).json({
      error: "Erreur lors du chargement de la configuration"
    });
  }
});

// GET /api/cases - Récupérer tous les dossiers (avec filtres optionnels)
router.get("/api/cases", async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      magasin: req.query.magasin,
      service: req.query.service
    };
    
    const cases = await dataManager.getAllCases(filters);
    
    res.json({
      success: true,
      data: cases,
      count: cases.length
    });
  } catch (error) {
    console.error("Erreur GET /api/cases:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la récupération des dossiers"
    });
  }
});

// GET /api/cases/:no - Récupérer un dossier spécifique
router.get("/api/cases/:no", async (req, res) => {
  try {
    const caseNo = req.params.no;
    const caseData = await dataManager.getCaseByNo(caseNo);
    
    res.json({
      success: true,
      data: caseData
    });
  } catch (error) {
    console.error(`Erreur GET /api/cases/${req.params.no}:`, error);
    
    if (error.message.includes("introuvable")) {
      res.status(404).json({
        success: false,
        error: `Dossier ${req.params.no} introuvable`
      });
    } else {
      res.status(500).json({
        success: false,
        error: "Erreur lors de la récupération du dossier"
      });
    }
  }
});

// POST /api/cases - Créer un nouveau dossier
router.post("/api/cases", async (req, res) => {
  try {
    const newCase = await dataManager.addCase(req.body);
    
    res.status(201).json({
      success: true,
      data: newCase
    });
  } catch (error) {
    console.error("Erreur POST /api/cases:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la création du dossier"
    });
  }
});

// POST /api/cases/:no/status - Mettre à jour le statut d'un dossier
router.post("/api/cases/:no/status", async (req, res) => {
  try {
    const caseNo = req.params.no;
    const { status, estimation } = req.body;
    
    const updates = {
      status,
      ...(estimation !== undefined && { estimation })
    };
    
    const updatedCase = await dataManager.updateCase(caseNo, updates);
    
    // Si le statut est "Renvoyé" ou "Pièce Renvoyé", envoyer un email au client
    if (status === "Renvoyé" || status === "Pièce Renvoyé" || status === "Pièce renvoyé à l'agence") {
      try {
        const emailResult = await emailSender.sendPieceReturnedEmail(updatedCase);
        if (emailResult.sent) {
          console.log(`[ATELIER] Email de retour envoyé à ${emailResult.to} pour le dossier ${caseNo}`);
        } else {
          console.warn(`[ATELIER] Email de retour non envoyé pour le dossier ${caseNo}: ${emailResult.reason}`);
        }
      } catch (emailError) {
        console.error(`[ATELIER] Erreur envoi email de retour dossier ${caseNo}:`, emailError);
      }
    }
    
    res.json({
      success: true,
      data: updatedCase
    });
  } catch (error) {
    console.error(`Erreur POST /api/cases/${req.params.no}/status:`, error);
    
    if (error.message.includes("introuvable")) {
      res.status(404).json({
        success: false,
        error: `Dossier ${req.params.no} introuvable`
      });
    } else {
      res.status(500).json({
        success: false,
        error: "Erreur lors de la mise à jour du statut"
      });
    }
  }
});

// DELETE /api/cases/:no - Supprimer un dossier (admin uniquement)
router.delete("/api/cases/:no", async (req, res) => {
  try {
    const caseNo = req.params.no;
    await dataManager.deleteCase(caseNo);

    res.json({
      success: true,
      message: `Dossier ${caseNo} supprimé`
    });
  } catch (error) {
    console.error(`Erreur DELETE /api/cases/${req.params.no}:`, error);

    if (error.message.includes("introuvable")) {
      res.status(404).json({
        success: false,
        error: `Dossier ${req.params.no} introuvable`
      });
    } else {
      res.status(500).json({
        success: false,
        error: "Erreur lors de la suppression du dossier"
      });
    }
  }
});

// PUT /api/cases/:no - Mettre à jour un dossier complet
router.put("/api/cases/:no", async (req, res) => {
  try {
    const caseNo = req.params.no;
    const updatedCase = await dataManager.updateCase(caseNo, req.body);
    
    res.json({
      success: true,
      data: updatedCase
    });
  } catch (error) {
    console.error(`Erreur PUT /api/cases/${req.params.no}:`, error);
    
    if (error.message.includes("introuvable")) {
      res.status(404).json({
        success: false,
        error: `Dossier ${req.params.no} introuvable`
      });
    } else {
      res.status(500).json({
        success: false,
        error: "Erreur lors de la mise à jour du dossier"
      });
    }
  }
});

// GET /api/lignes - Récupérer toutes les lignes actives
router.get("/api/lignes", async (req, res) => {
  try {
    const lignes = await dataManager.getLignes();
    
    res.json({
      success: true,
      data: lignes,
      count: lignes.length
    });
  } catch (error) {
    console.error("Erreur GET /api/lignes:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la récupération des lignes"
    });
  }
});

// GET /api/regles - Récupérer les règles de référence (avec filtres)
router.get("/api/regles", async (req, res) => {
  try {
    const filters = {
      service: req.query.service,
      cylindres: req.query.cylindres ? parseInt(req.query.cylindres) : undefined,
      carburant: req.query.carburant
    };
    
    const regles = await dataManager.getReglesRef(filters);
    
    res.json({
      success: true,
      data: regles,
      count: regles.length
    });
  } catch (error) {
    console.error("Erreur GET /api/regles:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la récupération des règles"
    });
  }
});

// POST /api/cache/clear - Vider le cache (utile après mise à jour manuelle du JSON)
router.post("/api/cache/clear", (req, res) => {
  try {
    dataManager.clearCache();
    res.json({
      success: true,
      message: "Cache vidé"
    });
  } catch (error) {
    console.error("Erreur POST /api/cache/clear:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors du vidage du cache"
    });
  }
});

// GET /api/health - Vérifier la santé de l'API et la connexion FTP
router.get("/api/health", async (req, res) => {
  try {
    await dataManager.getData(false); // Test de connexion
    res.json({
      success: true,
      status: "healthy",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
