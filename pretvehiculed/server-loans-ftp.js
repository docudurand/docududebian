// API pret vehicule (FTP JSON + PDF + email)
// Version modifiée pour utiliser FTP au lieu de Google Sheets

import express from 'express';
import QRCode from 'qrcode';
import { transporter, fromEmail } from '../mailer.js';
import * as ftpStorage from './ftp-loans-storage.js';

// routeur Express separe
const router = express.Router();

// Vérifie la configuration FTP au démarrage
const ftpCheck = ftpStorage.checkFtpConfig();
if (!ftpCheck.ok) {
  console.error('[PRET-VEHICULE] Configuration FTP manquante:', ftpCheck.error);
  console.error('[PRET-VEHICULE] Assurez-vous que FTP_HOST, FTP_USER, FTP_PASSWORD sont définis');
}

// Liste des vehicules disponibles
router.get('/vehicles', async (_req, res) => {
  try {
    const result = await ftpStorage.listVehicles();
    res.json(result);
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'ftp_error', 
      detail: e.message 
    });
  }
});


// Mise à jour d’un véhicule
router.post('/vehicles/:vehicle_id/update', async (req, res) => {
  try {
    const result = await ftpStorage.updateVehicle(req.params.vehicle_id, req.body);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok:true, vehicle: result.vehicle });
  } catch (e) {
    res.status(500).json({ ok:false, error:'ftp_error', detail:e.message });
  }
});



// Liste des magasins
router.get('/stores', async (_req, res) => {
  try {
    const result = await ftpStorage.listStores();
    res.json(result);
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'ftp_error', 
      detail: e.message 
    });
  }
});

// Recherche de prets
router.get('/loans/search', async (req, res) => {
  try {
    const { immat = '', date = '' } = req.query;
    const loans = await ftpStorage.searchLoans(immat, date);
    res.json(loans);
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'ftp_error', 
      detail: e.message 
    });
  }
});

// Creation d'un pret
router.post('/loans', async (req, res) => {
  try {
    const result = await ftpStorage.createLoan(req.body);
    
    if (!result.ok) {
      return res.status(400).json(result);
    }
    
    res.json({ 
      ok: true, 
      loan_id: result.loan_id 
    });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'ftp_error', 
      detail: e.message 
    });
  }
});

// Mise a jour d'un pret
router.post('/loans/:loan_id/update', async (req, res) => {
  try {
    const result = await ftpStorage.updateLoan(req.params.loan_id, req.body);
    
    if (!result.ok) {
      return res.status(400).json(result);
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'ftp_error', 
      detail: e.message 
    });
  }
});

// Cloture d'un pret
router.post('/loans/:loan_id/close', async (req, res) => {
  try {
    const closeData = {
      vehicle_id: req.body.vehicle_id,
      date_retour: req.body.date_retour,
      heure_retour: req.body.heure_retour,
      receptionnaire_retour: req.body.receptionnaire_retour
    };
    
    const result = await ftpStorage.closeLoan(req.params.loan_id, closeData);
    
    if (!result.ok) {
      return res.status(400).json(result);
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'ftp_error', 
      detail: e.message 
    });
  }
});

// Genere la page HTML imprimable (PDF)
router.post('/loans/print', async (req, res) => {
  try {
    const d = req.body || {};
    const pad2 = n => String(n).padStart(2,'0');
    const parseMaybeDate = v => {
      if (!v && v !== 0) return null;
      if (v instanceof Date) return isNaN(v) ? null : v;
      if (typeof v === 'number') { 
        const ms = Math.round((v-25569)*86400*1000); 
        const dt=new Date(ms); 
        return isNaN(dt)?null:dt; 
      }
      if (typeof v === 'string') {
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)){ 
          const[h,m]=v.split(':'); 
          const dt=new Date(); 
          dt.setHours(+h,+m||0,0,0); 
          return dt; 
        }
        const dt = new Date(v); 
        if (!isNaN(dt)) return dt;
        const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/); 
        if(m){ 
          const dt2=new Date(+m[1],+m[2]-1,+m[3]); 
          return isNaN(dt2)?null:dt2; 
        }
      }
      return null;
    };
    const fmtDate = v => { 
      const dt=parseMaybeDate(v); 
      return dt ? `${pad2(dt.getDate())}/${pad2(dt.getMonth()+1)}/${String(dt.getFullYear()).slice(-2)}` : ''; 
    };
    const fmtTime = v => { 
      const dt=parseMaybeDate(v); 
      return dt ? `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}` : ''; 
    };

    const proto  = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
    const host   = (req.headers['x-forwarded-host']  || req.headers['host'] || '').toString().split(',')[0];
    const origin = host ? `${proto}://${host}` : (process.env.PUBLIC_BASE_URL || '');
    const closeUrl  = `${origin}/pret/close.html?loan_id=${encodeURIComponent(d.loan_id || '')}&immat=${encodeURIComponent(d.immatriculation || '')}`;
    const qrDataUrl = await QRCode.toDataURL(closeUrl, { margin: 1, width: 110 });

    const LOGO_URL   = 'https://raw.githubusercontent.com/docudurand/mes-formulaires/main/logodurand.png';
    const CAR_URL    = 'https://raw.githubusercontent.com/docudurand/mes-formulaires/main/voiture.png';
    const GAUGE_URL  = 'https://raw.githubusercontent.com/docudurand/mes-formulaires/main/jauge.png';

    const esc = s => String(s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Fiche prêt ${esc(d.immatriculation)}</title>
<style>
  @page{ size:A4; margin:0 }

  body{ font-family:Arial,Helvetica,sans-serif; color:#111; margin:12mm; }

  .header{
    display:grid; grid-template-columns:120px 1fr 120px;
    align-items:center; column-gap:8px; margin-bottom:0;
  }
  .logo{ width:120px; height:auto; object-fit:contain }
  .title{ text-align:center; margin:0; font-size:20px; font-weight:700; letter-spacing:.3px }
  .qrcode{ width:110px; height:110px; justify-self:end }

  .afterHead{ margin-top:6mm; }

  .line{ margin:4px 0 6px; font-size:14px }
  .grid{ display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; margin-top:6px; }
  .label{ font-weight:700 }

  .box{ border:1px solid #222; height:120px; margin-top:18px; display:grid; grid-template-columns:1fr 1fr; }
  .box h3{ margin:-10px 0 4px 8px; font-size:14px }
  .cell{ padding:12px; border-right:1px solid #222 }
  .cell:last-child{ border-right:0 }

  .pics{
    display:grid;
    grid-template-columns:1.3fr 1fr;
    gap:8mm;
    align-items:start;
    margin:16px 0;
  }
  .imgCard{ border:1px solid #222; padding:8px; display:flex; align-items:center; justify-content:center; background:#fff; }
  .imgCard.tall{ height:70mm; }
  .imgCard.short{ height:40mm; }
  .imgFit{ max-width:100%; max-height:100%; object-fit:contain; }

  .obs{ margin-top:20px }
  .area{ border:1px solid #222; height:100px; padding:8px; white-space:pre-wrap }

  .legal{ margin-top:8mm; font-size:9pt; color:#000; }
</style>
</head>
<body>

  <div class="header">
    <img class="logo" src="${LOGO_URL}" alt="Logo Durand">
    <h1 class="title">FICHE PRÊT VÉHICULE DURAND</h1>
    <img class="qrcode" alt="QR clôture" src="${qrDataUrl}">
  </div>

  <div class="afterHead">
    <div class="line">MAGASIN : <strong>${esc(d.magasin_pret)}</strong></div>

    <div class="grid">
      <div><span class="label">NOM DU CHAUFFEUR : </span>${esc(d.chauffeur_nom)}</div>
      <div><span class="label">IMMATRICULATION : </span>${esc(d.immatriculation)}</div>

      <div><span class="label">DATE DÉPART : </span>${fmtDate(d.date_depart)}</div>
      <div><span class="label">DATE RETOUR : </span>${fmtDate(d.date_retour)}</div>

      <div><span class="label">HEURE DÉPART : </span>${fmtTime(d.heure_depart)}</div>
      <div><span class="label">HEURE RETOUR : </span>${fmtTime(d.heure_retour)}</div>
    </div>

    <div class="box">
      <div class="cell">
        <h3>DÉPART</h3>
        Réceptionnaire<br><br>Signature
      </div>
      <div class="cell">
        <h3>RETOUR</h3>
        Réceptionnaire<br><br>Signature
      </div>
    </div>

    <div class="box">
      <div class="cell">
        <h3>DÉPART (CONDUCTEUR)</h3>
        Conducteur<br><br>Signature
      </div>
      <div class="cell">
        <h3>RETOUR (CONDUCTEUR)</h3>
        Conducteur<br><br>Signature
      </div>
    </div>

    <div class="pics">
      <div class="imgCard tall">
        <img class="imgFit" src="${CAR_URL}" alt="Schémas véhicule">
      </div>
      <div class="imgCard short">
        <img class="imgFit" src="${GAUGE_URL}" alt="Jauge de carburant">
      </div>
    </div>

    <div class="obs">
      <div class="label">INFORMATION CHAUFFEUR :</div>
      <div class="area">${esc(d.observations)}</div>
    </div>

    <div class="legal">
      Attention : prévoir un transfert d'assurance pendant le prêt du véhicule. Sinon en cas d'accident un montant de 2500 euros sera à votre charge. Merci de votre compréhension.
    </div>
  </div>

  <script>window.onload=()=>{ setTimeout(()=>window.print(), 100); };</script>
</body>
</html>`;

    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('<h1>Erreur</h1>');
  }
});

// Envoi email recap pret
router.post('/loans/email', async (req, res) => {
  try {
    const loan = req.body?.loan || {};
    const rawAtts = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

    if (!transporter) {
      return res.status(500).json({ ok:false, error:'smtp_not_configured' });
    }

    const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
    const host  = (req.headers['x-forwarded-host'] || req.headers['host'] || '').toString().split(',')[0];
    const origin = host ? `${proto}://${host}` : (process.env.PUBLIC_BASE_URL || "");

    const to = (process.env.PRET_MAIL_TO || process.env.MAIL_TO || "").trim();
    if (!to) return res.status(500).json({ ok:false, error:"mail_to_missing" });
    
    const subject = `NOUVEAU PRÊT — ${loan.immatriculation || '—'} — ${loan.magasin_pret || '—'}`;

    const rows = [
      ['Magasin', loan.magasin_pret||''],
      ['Immatriculation', loan.immatriculation||''],
      ['Chauffeur', loan.chauffeur_nom||''],
      ['Transfert assurance', loan.transfert_assurance || ''],
      ['Départ', [loan.date_depart||'', loan.heure_depart||''].filter(Boolean).join(' ')],
      ['Réceptionnaire (départ)', loan.receptionnaire_depart||''],
      ['Information chauffeur', (loan.observations||'').replace(/\n/g,'<br>')]
    ];
    
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif">
        <h2 style="margin:0 0 8px">Nouveau prêt véhicule</h2>
        <table style="border-collapse:collapse">
          ${rows.map(([k,v])=>`<tr><td style="border:1px solid #ddd;padding:6px 10px;font-weight:600">${k}</td><td style="border:1px solid #ddd;padding:6px 10px">${v||''}</td></tr>`).join('')}
        </table>
        <p style="margin-top:12px">
          Clôturer le prêt :
          <a href="${origin}/pret/close.html?loan_id=${encodeURIComponent(loan.loan_id||'')}&immat=${encodeURIComponent(loan.immatriculation||'')}">
            ${origin}/pret/close.html?loan_id=…
          </a>
        </p>
      </div>`;

    const attachments = rawAtts.map(a => ({
      filename: a.filename || 'pj',
      content:  a.content   || '',
      encoding: 'base64',
      contentType: a.contentType || 'application/octet-stream'
    }));

    const info = await transporter.sendMail({
      from: `"Prêts Véhicules" <${fromEmail}>`,
      to,
      subject,
      html,
      attachments
    });

    res.json({ ok:true, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ ok:false, error:'mail_send_failed', detail:e.message });
  }
});

// Route d'initialisation depuis Excel (à utiliser une fois pour migrer)
router.post('/loans/init-from-excel', async (req, res) => {
  try {
    const excelData = req.body?.data || [];
    const result = await ftpStorage.initializeFromExcel(excelData);
    res.json(result);
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'init_failed', 
      detail: e.message 
    });
  }
});

export default router;
