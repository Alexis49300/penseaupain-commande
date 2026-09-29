// Fonction serverless Vercel : authentifie l'utilisateur, cloisonne les données par site, puis relaie vers Apps Script.
// Variables d'environnement : APPS_SCRIPT_URL, APPS_SECRET, SESSION_SECRET,
//   ADMIN_PASSWORD (propriétaire : voit tous les sites), PASSWORD_LB (La Boulange), PASSWORD_BSC (BSC)
const crypto = require('crypto');
const { APPS_SCRIPT_URL, APPS_SECRET, SESSION_SECRET, ADMIN_PASSWORD } = process.env;

// Les sites (boulangeries). L'id court est inscrit dans la colonne "site" de l'onglet Produits.
const SITES = {
  LB: { nom: 'La Boulange', pw: process.env.PASSWORD_LB },
  BSC: { nom: 'BSC', pw: process.env.PASSWORD_BSC }
};

const mac = b => crypto.createHmac('sha256', SESSION_SECRET).update(b).digest('base64url');
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + mac(b); };
const verify = t => {
  try {
    const [b, s] = t.split('.');
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(mac(b)))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
};
const gas = async body => {
  const r = await fetch(APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow', body: JSON.stringify({ secret: APPS_SECRET, ...body }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error === 'unauthorized' ? 'Configuration serveur invalide' : j.error);
  return j.data;
};
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Ne garde pour un site que ses produits, ses lignes de commande et les clients qui en ont dans leur mercuriale.
const scope = (d, orders, site) => {
  if (site === '*') return { ...d, orders };
  const ids = new Set(d.produits.filter(x => x.site === site).map(x => x.id));
  return {
    produits: d.produits.filter(x => ids.has(x.id)),
    clients: d.clients.map(c => ({ ...c, m: Object.fromEntries(Object.entries(c.m).filter(([k]) => ids.has(k))) })).filter(c => Object.keys(c.m).length),
    orders: orders.map(o => ({ ...o, lignes: o.lignes.filter(l => ids.has(l.p)) })).filter(o => o.lignes.length)
  };
};

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    const b = req.body || {}, exp = Date.now() + 12 * 3600e3;
    if (b.action === 'login') {
      if (b.password !== undefined) {
        const pw = String(b.password);
        let site = null;
        if (ADMIN_PASSWORD && safeEq(pw, ADMIN_PASSWORD)) site = '*';
        else for (const [id, s] of Object.entries(SITES)) if (s.pw && safeEq(pw, s.pw)) site = id;
        if (!site) return res.status(401).json({ error: 'Mot de passe incorrect' });
        return res.json({ token: sign({ role: 'admin', site, exp }), role: 'admin', nom: site === '*' ? 'Propriétaire' : SITES[site].nom });
      }
      const c = await gas({ action: 'login', code: String(b.code || '') });
      return res.json({ token: sign({ role: 'client', clientId: c.id, exp }), role: 'client', nom: c.nom });
    }
    const p = verify((req.headers.authorization || '').replace('Bearer ', ''));
    if (!p) return res.status(401).json({ error: 'Session expirée, reconnectez-vous' });
    const admin = p.role === 'admin', today = new Date().toISOString().slice(0, 10);
    if (b.action === 'boot') {
      if (!admin) return res.json({ catalog: await gas({ action: 'catalog', clientId: p.clientId }), orders: await gas({ action: 'orders', clientId: p.clientId, from: today }) });
      const d = new Date(), from = new Date(d.getFullYear(), d.getMonth() - 1, 2).toISOString().slice(0, 10);
      const [data, orders] = await Promise.all([gas({ action: 'admin' }), gas({ action: 'orders', from })]);
      return res.json({ ...scope(data, orders, p.site), site: p.site, sites: Object.entries(SITES).map(([id, s]) => ({ id, nom: s.nom })) });
    }
    if (b.action === 'saveOrder') return res.json(await gas({ action: 'saveOrder', clientId: admin ? b.clientId : p.clientId, date: b.date, lignes: b.lignes || {}, admin }));
    if (b.action === 'saveProduct' && admin) {
      const site = p.site === '*' ? b.site : p.site;
      if (!SITES[site]) return res.status(400).json({ error: 'Choisissez le site fabricant' });
      return res.json(await gas({ action: 'saveProduct', id: b.id, cat: b.cat, nom: b.nom, px: b.px, dispo: b.dispo, addAll: b.addAll, site, scope: p.site }));
    }
    if (b.action === 'saveClient' && admin) return res.json(await gas({ action: 'saveClient', id: b.id, nom: b.nom, contact: b.contact, code: b.code, m: b.m || {}, link: !!b.link, site: p.site }));
    return res.status(403).json({ error: 'Action non autorisée' });
  } catch (e) { return res.status(400).json({ error: e.message }); }
};
