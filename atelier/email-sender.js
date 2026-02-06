// Module d'envoi d'emails pour le module atelier
import { transporter, fromEmail } from "../mailer.js";

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nl2br(v) {
  return escapeHtml(v).replace(/\n/g, "<br>");
}

// Mapping des services vers les emails des responsables
function getEmailForService(service) {
  const serviceKey = String(service || "").trim().toUpperCase();
  
  const mapping = {
    // Rectification Culasse
    "RECTIFICATION CULASSE": process.env.DEST_EMAIL_ATELIER_CULASSE,
    
    // Rectification Vilebrequin (pas de variable spécifique mentionnée)
    "RECTIFICATION VILEBREQUIN": process.env.DEST_EMAIL_ATELIER_CULASSE, // Même email que culasse ?
    
    // Services Chasse (Volant + Machoires)
    "RECTIFICATION DES VOLANTS MOTEUR": process.env.DEST_EMAIL_ATELIER_CHASSE,
    "REGARNISSAGES MACHOIRES": process.env.DEST_EMAIL_ATELIER_CHASSE,
    
    // Injection Diesel
    "CONTRÔLE INJECTION DIESEL": process.env.DEST_EMAIL_ATELIER_DIESEL,
    "CONTROLE INJECTION DIESEL": process.env.DEST_EMAIL_ATELIER_DIESEL,
    
    // Injection Essence
    "CONTRÔLE INJECTION ESSENCE": process.env.DEST_EMAIL_ATELIER_ESSENCE,
    "CONTROLE INJECTION ESSENCE": process.env.DEST_EMAIL_ATELIER_ESSENCE,
    
    // Arbre de Transmission
    "ARBRE DE TRANSMISSION": process.env.DEST_EMAIL_ATELIER_ARBRE
  };
  
  return mapping[serviceKey] || process.env.DEST_EMAIL_ATELIER_CULASSE || "";
}

// Formater une date
function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("fr-FR", { 
    day: "2-digit", 
    month: "2-digit", 
    year: "numeric" 
  });
}

// Email lors de la création d'une demande
export async function sendNewRequestEmail(caseData) {
  if (!transporter) {
    console.warn("[ATELIER] SMTP non configuré, email non envoyé");
    return { sent: false, reason: "SMTP non configuré" };
  }
  
  const header = (caseData.snapshot && caseData.snapshot.header) || {};
  const service = caseData.service || header.service || "";
  const recipientEmail = getEmailForService(service);
  
  if (!recipientEmail) {
    console.warn(`[ATELIER] Aucun email configuré pour le service "${escapeHtml(service)}"`);
    return { sent: false, reason: "Email non configuré" };
  }
  
  const no = String(caseData.no || "").padStart(5, "0");
  const client = caseData.client || header.client || "";
  const magasin = caseData.magasin || header.magasin || "";
  const compte = header.compte || "";
  const telephone = header.telephone || "";
  const email = header.email || "";
  const vehicule = header.vehicule || "";
  const immat = header.immat || "";
  const dateDemande = formatDate(caseData.demandeDate || header.dateDemande);
  
  // Détails (comme le PDF) : choix sélectionnés + commentaire (sans QR Code)
  const snapshot = (caseData && caseData.snapshot) || {};
  const commentairesRaw = (snapshot.commentaires || "").trim();
  const culasse = snapshot.culasse || null;
  const injecteur = snapshot.injecteur || null;

  const sections = [];

  // Détails "Rectification Culasse"
  if (service === "Rectification Culasse" && culasse) {
    const ops = Array.isArray(culasse.operations) ? culasse.operations : [];
    const pieces = Array.isArray(culasse.piecesAFournir) ? culasse.piecesAFournir : [];

    const opsHtml = ops.length
      ? `<ul style="margin:6px 0 0; padding-left:18px;">
          ${ops.map(op => {
            const refs = Array.isArray(op.references) ? op.references : [];
            const refsHtml = refs.length
              ? `<ul style="margin:6px 0 0 0; padding-left:18px;">
                  ${refs.map(r => {
                    const prix = (r.prixHT || r.prixHT === 0) ? ` – ${escapeHtml(r.prixHT)} € HT` : "";
                    const libRef = r.libelleRef ? ` – ${escapeHtml(r.libelleRef)}` : "";
                    return `<li><strong>${escapeHtml(r.reference || "")}</strong>${libRef}${prix}</li>`;
                  }).join("")}
                </ul>`
              : "";
            return `<li>
              <strong>${escapeHtml(op.libelle || op.ligne || "")}</strong>
              ${refsHtml}
            </li>`;
          }).join("")}
        </ul>`
      : `<div style="font-size:13px; color:#64748b;">Aucune opération cochée.</div>`;

    const piecesHtml = pieces.length
      ? `<ul style="margin:6px 0 0; padding-left:18px;">${pieces.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
      : `<div style="font-size:13px; color:#64748b;">Aucune pièce à fournir sélectionnée.</div>`;

    sections.push(`
      <div style="margin-top: 20px; padding: 15px; background: #f8fafc; border-left: 4px solid #004080;">
        <div style="font-weight: 700; margin-bottom: 10px;">Détails Rectification Culasse</div>
        <div style="font-size: 13px; color: #475569; line-height: 1.5;">
          <div><strong>VL / PL :</strong> ${escapeHtml(culasse.segment || "–")}</div>
          <div><strong>Cylindre :</strong> ${escapeHtml(culasse.cylindre || "–")}</div>
          <div><strong>Soupapes :</strong> ${escapeHtml(culasse.soupapes || "–")}</div>
          <div><strong>Carburant :</strong> ${escapeHtml(culasse.carburant || "–")}</div>
        </div>

        <div style="margin-top:12px; font-weight:700;">Opérations sélectionnées</div>
        ${opsHtml}

        <div style="margin-top:12px; font-weight:700;">Pièces à fournir</div>
        ${piecesHtml}
      </div>
    `);
  }

  // Détails "Contrôle injection"
  if ((service === "Contrôle injection Diesel" || service === "Contrôle injection Essence") && injecteur) {
    sections.push(`
      <div style="margin-top: 20px; padding: 15px; background: #f8fafc; border-left: 4px solid #004080;">
        <div style="font-weight: 700; margin-bottom: 10px;">Détails Contrôle injection</div>
        <div style="font-size: 13px; color: #475569; line-height: 1.5;">
          <div><strong>Type :</strong> ${escapeHtml(injecteur.type || (service.includes("Diesel") ? "Diesel" : "Essence"))}</div>
          <div><strong>Nombre d’injecteurs :</strong> ${escapeHtml(injecteur.nombre || "–")}</div>
        </div>
      </div>
    `);
  }

  // Commentaires (tous services)
  if (commentairesRaw) {
    sections.push(`
      <div style="margin-top: 20px; padding: 15px; background: #fff7ed; border-left: 4px solid #f97316;">
        <div style="font-weight: 700; margin-bottom: 10px;">Commentaire</div>
        <div style="font-size: 13px; color: #7c2d12; line-height: 1.5;">${nl2br(commentairesRaw)}</div>
      </div>
    `);
  }

  const detailsHTML = sections.join("");

  try {
    await transporter.sendMail({
      from: `Atelier Durand Services <${fromEmail}>`,
      to: recipientEmail,
      subject: `[Nouvelle demande] Dossier ${escapeHtml(no)} – ${escapeHtml(service)} – ${escapeHtml(client)}`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: #f3f4f6; }
    .container { max-width: 650px; margin: 30px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: #004080; color: white; padding: 25px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 600; }
    .content { padding: 30px; }
    .intro { font-size: 15px; line-height: 1.6; color: #334155; margin-bottom: 25px; }
    .dossier-number { display: inline-block; background: #004080; color: white; padding: 8px 16px; border-radius: 20px; font-weight: 700; font-size: 14px; margin: 10px 0 20px 0; }
    .info-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .info-table td { padding: 12px 0; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    .info-table td:first-child { font-weight: 600; color: #475569; width: 180px; }
    .info-table td:last-child { color: #0f172a; }
    .footer { padding: 20px 30px; background: #f8fafc; border-top: 1px solid #e5e7eb; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📋 Nouvelle demande – Dossier ${escapeHtml(no)}</h1>
    </div>
    <div class="content">
      <div class="intro">
        <strong>Bonjour,</strong><br><br>
        Nous vous informons qu'une nouvelle demande a été créée.
      </div>
      
      <div class="dossier-number">N° dossier ${escapeHtml(no)}</div>
      
      <table class="info-table">
        <tr>
          <td>Service</td>
          <td><strong>${escapeHtml(service)}</strong></td>
        </tr>
        <tr>
          <td>Client</td>
          <td>${escapeHtml(client)}</td>
        </tr>
        <tr>
          <td>N° de compte client</td>
          <td>${escapeHtml(compte)}</td>
        </tr>
        <tr>
          <td>Téléphone client</td>
          <td>${escapeHtml(telephone)}</td>
        </tr>
        <tr>
          <td>Adresse mail magasinier/réceptionnaire</td>
          <td>${escapeHtml(email)}</td>
        </tr>
        <tr>
          <td>Marque/Modèle</td>
          <td>${escapeHtml(vehicule)}</td>
        </tr>
        <tr>
          <td>Immatriculation</td>
          <td>${escapeHtml(immat)}</td>
        </tr>
        <tr>
          <td>Magasin</td>
          <td><strong>${escapeHtml(magasin)}</strong></td>
        </tr>
        <tr>
          <td>Date de la demande</td>
          <td>${escapeHtml(dateDemande)}</td>
        </tr>
      </table>
      
      ${detailsHTML}
    </div>
    <div class="footer">
      Ce message a été généré automatiquement par le système de gestion atelier.
    </div>
  </div>
</body>
</html>
      `
    });
    
    console.log(`[ATELIER] Email envoyé pour le dossier ${escapeHtml(no)} à ${recipientEmail}`);
    return { sent: true, to: recipientEmail };
  } catch (error) {
    console.error(`[ATELIER] Erreur envoi email dossier ${escapeHtml(no)}:`, error);
    return { sent: false, reason: error.message };
  }
}

// Email lors du passage au statut "Pièce Renvoyé"
export async function sendPieceReturnedEmail(caseData) {
  if (!transporter) {
    console.warn("[ATELIER] SMTP non configuré, email non envoyé");
    return { sent: false, reason: "SMTP non configuré" };
  }
  
  const header = (caseData.snapshot && caseData.snapshot.header) || {};
  const clientEmail = header.email || "";
  
  if (!clientEmail) {
    console.warn(`[ATELIER] Aucun email client pour le dossier ${caseData.no}`);
    return { sent: false, reason: "Email client non renseigné" };
  }
  
  const no = String(caseData.no || "").padStart(5, "0");
  const client = caseData.client || header.client || "";
  const magasin = caseData.magasin || header.magasin || "";
  const service = caseData.service || header.service || "";
  const vehicule = header.vehicule || "";
  const immat = header.immat || "";
  
  try {
    await transporter.sendMail({
      from: `Atelier Durand Services <${fromEmail}>`,
      to: clientEmail,
      subject: `Votre dossier ${escapeHtml(no)} – ${escapeHtml(service)} – ${escapeHtml(client)}`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background: #f3f4f6; }
    .container { max-width: 650px; margin: 30px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: #16a34a; color: white; padding: 25px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 600; }
    .content { padding: 30px; }
    .intro { font-size: 15px; line-height: 1.6; color: #334155; margin-bottom: 25px; }
    .highlight-box { background: #d1fae5; border-left: 4px solid #16a34a; padding: 20px; margin: 20px 0; border-radius: 4px; }
    .highlight-box strong { color: #065f46; font-size: 16px; }
    .info-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .info-table td { padding: 12px 0; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    .info-table td:first-child { font-weight: 600; color: #475569; width: 140px; }
    .info-table td:last-child { color: #0f172a; }
    .footer { padding: 20px 30px; background: #f8fafc; border-top: 1px solid #e5e7eb; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>✅ Pièce renvoyée</h1>
    </div>
    <div class="content">
      <div class="intro">
        <strong>Bonjour,</strong><br><br>
        Nous vous informons que les travaux sont terminés et que la pièce a été <strong>renvoyée</strong>.
      </div>
      
      <div class="highlight-box">
        <strong>La pièce est disponible au magasin ${escapeHtml(magasin)}.</strong>
      </div>
      
      <table class="info-table">
        <tr>
          <td>N° de dossier</td>
          <td><strong>${escapeHtml(no)}</strong></td>
        </tr>
        <tr>
          <td>Service</td>
          <td>${escapeHtml(service)}</td>
        </tr>
        <tr>
          <td>Client</td>
          <td>${escapeHtml(client)}</td>
        </tr>
        <tr>
          <td>Magasin</td>
          <td><strong>${escapeHtml(magasin)}</strong></td>
        </tr>
      </table>
    </div>
    <div class="footer">
      Cordialement,<br>
      <strong>Durand Services – Atelier</strong><br><br>
      Ce message a été généré automatiquement par le système de gestion atelier.<br>
      Pour toute question, contactez votre magasin.
    </div>
  </div>
</body>
</html>
      `
    });
    
    console.log(`[ATELIER] Email envoyé pour le dossier ${escapeHtml(no)} à ${clientEmail}`);
    return { sent: true, to: clientEmail };
  } catch (error) {
    console.error(`[ATELIER] Erreur envoi email dossier ${escapeHtml(no)}:`, error);
    return { sent: false, reason: error.message };
  }
}

export default {
  sendNewRequestEmail,
  sendPieceReturnedEmail,
  getEmailForService
};
