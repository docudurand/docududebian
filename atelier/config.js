// Fichier servi en statique par nginx
// Les pages Atelier attendent window.__ATELIER_CFG.GS_URL
window.__ATELIER_CFG = {
  // Cette URL DOIT retourner directement du JSON: { lignes: [...], regles: [...] }
  GS_URL: "/atelier/api/config"
};
