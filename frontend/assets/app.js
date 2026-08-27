/* ============================================================================
   NetMap — application web (SPA sans dépendance, pur JavaScript).
   Reprend fidèlement le design du modèle et le connecte à l'API REST.
   ========================================================================== */
"use strict";

// ─────────────────────────────── État global ───────────────────────────────
const state = {
  data: { networks: [], ips: {} },
  settings: { scanIntervalMinutes: 30, pingTimeoutSeconds: 10, pingSpacingSeconds: 1 },
  scan: { isScanning: false, roundActive: false, lastFullScanAt: null, nextScanAt: null, progress: { done: 0, total: 0, currentIp: null } },
  serverNow: Date.now(),
  fetchedAt: Date.now(),
  fieldSeparator: "\\\\\\",   // séparateur affiché entre MAC / Description / Pièce
  theme: document.documentElement.getAttribute("data-theme") || "light",
  activeTab: "plan",
  filter: "all",
  search: "",           // recherche dans le plan d'adressage (IP, nom, MAC…)
  currentNetworkId: null,
  menuKey: null,
  modal: null,          // 'ip' | 'network' | 'editNetwork' | 'device' | 'port' | 'settings'
  draft: {},
  draftDirty: false,    // un champ a-t-il été modifié ? (clic à l'extérieur = enregistrer)
  focusedKey: null,
  scrollTo: null,
  loadError: null,
  // Authentification : le jeton est mémorisé sur l'appareil (localStorage),
  // la connexion survit donc aux fermetures d'onglet et aux redémarrages.
  token: (() => { try { return localStorage.getItem("netmap.token") || ""; } catch (e) { return ""; } })(),
  needAuth: false,
  authRequired: false,
  authError: null,
  authBusy: false,
};

const app = document.getElementById("app");

// Les animations d'entrée ne doivent jouer QUE lorsque le contenu apparaît
// vraiment (changement d'onglet, ouverture d'une modale). Sinon le moindre
// re-rendu (clic sur un bouton, sondage réseau) provoquerait un flash.
let shownTab = null, shownModal = null;
let animTab = false, animModal = false;
const animSection = () => (animTab ? "animation:nmfade .25s ease" : "");

// ─────────────────────────────── Utilitaires ───────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function serverNow() { return state.serverNow + (Date.now() - state.fetchedAt); }

function frDur(ms) {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "moins d'une minute";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  if (h < 24) { const rm = m % 60; return rm ? h + " h " + rm + " min" : h + " h"; }
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? d + " j " + rh + " h" : d + " j";
}

const TYPES = {
  ordinateur: { i: "ph-desktop", l: "Ordinateur" },
  telephone: { i: "ph-device-mobile", l: "Téléphone" },
  serveur: { i: "ph-hard-drives", l: "Serveur" },
  domotique: { i: "ph-house-line", l: "Domotique" },
  autre: { i: "ph-cube", l: "Autre" },
};
function typeOf(t) { return TYPES[t] || TYPES.autre; }

// Styles dynamiques (identiques au modèle)
const tabStyle = (a) => `display:flex;align-items:center;gap:8px;padding:12px 15px;border:none;background:transparent;cursor:pointer;font-weight:600;font-size:14px;white-space:nowrap;color:${a ? "var(--ink)" : "var(--ink-soft)"};border-bottom:2.5px solid ${a ? "var(--accent)" : "transparent"}`;
const chip = (a) => `display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:8px 13px;border-radius:999px;border:1px solid ${a ? "var(--ink)" : "var(--line-strong)"};background:${a ? "var(--ink)" : "transparent"};color:${a ? "var(--surface)" : "var(--ink-soft)"};font-weight:600;font-size:12.5px;cursor:pointer`;
const segOn = "flex:1;padding:10px 6px;border-radius:9px;border:1.5px solid var(--accent);background:var(--accent);color:var(--on-ocre);font-weight:700;font-size:12.5px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer";
const segOff = "flex:1;padding:10px 6px;border-radius:9px;border:1.5px solid var(--line-strong);background:transparent;color:var(--ink-soft);font-weight:600;font-size:12.5px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer";
const btnPrimary = "display:flex;align-items:center;gap:7px;padding:11px 15px;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:var(--on-ocre);font-weight:600;font-size:14px;cursor:pointer";
const btnGhost = "display:flex;align-items:center;gap:7px;padding:11px 15px;border-radius:10px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-weight:600;font-size:14px;cursor:pointer";

function currentNet() {
  const d = state.data;
  return d.networks.find((n) => n.id === state.currentNetworkId) || d.networks[0] || null;
}

/** Marque NetMap : graphe à 3 nœuds, identique au favicon (assets/favicon.svg). */
function logoMark(size) {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">
    <g fill="none" stroke="currentColor" stroke-width="4.2" stroke-linecap="round">
      <path d="M32 16 15 46"/><path d="M32 16 49 46"/><path d="M15 46h34"/>
    </g>
    <g fill="currentColor">
      <circle cx="32" cy="16" r="7.5"/><circle cx="15" cy="46" r="7.5"/><circle cx="49" cy="46" r="7.5"/>
    </g>
  </svg>`;
}

// ─────────────────────────────── Couche API ────────────────────────────────
const api = {
  headers(extra) {
    const h = Object.assign({}, extra);
    if (state.token) h.Authorization = "Bearer " + state.token;
    return h;
  },
  async fail(r) {
    let m; try { m = (await r.json()).detail; } catch (e) {}
    const err = new Error(m || ("HTTP " + r.status));
    err.status = r.status;
    return err;
  },
  async get(u) {
    const r = await fetch(u, { headers: this.headers() });
    if (!r.ok) throw await this.fail(r);
    return r.json();
  },
  async send(method, u, body) {
    const r = await fetch(u, {
      method,
      headers: this.headers({ "Content-Type": "application/json" }),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw await this.fail(r);
    return r.json();
  },
  post(u, b) { return this.send("POST", u, b); },
  put(u, b) { return this.send("PUT", u, b); },
  del(u) { return this.send("DELETE", u); },
};

/** Mémorise (ou efface) le jeton d'accès sur cet appareil. */
function setToken(value) {
  state.token = value || "";
  try {
    if (state.token) localStorage.setItem("netmap.token", state.token);
    else localStorage.removeItem("netmap.token");
  } catch (e) { /* navigation privée : on reste connecté le temps de l'onglet */ }
}

/** Jeton absent ou périmé : on repasse par l'écran de connexion. */
function forceLogin() {
  setToken("");
  state.needAuth = true;
  state.modal = null;
  state.menuKey = null;
  state.loadError = null;
  render();
}

async function reload() {
  const d = await api.get("/api/data");
  state.data = { networks: d.networks, ips: d.ips };
  state.settings = d.settings;
  state.scan = d.scan;
  if (d.fieldSeparator != null) state.fieldSeparator = d.fieldSeparator;
  state.authRequired = !!d.authRequired;
  state.serverNow = d.serverNow;
  state.fetchedAt = Date.now();
  state.loadError = null;
  if (!state.currentNetworkId || !d.networks.some((n) => n.id === state.currentNetworkId))
    state.currentNetworkId = d.networks[0] ? d.networks[0].id : null;
}

/** Envoie un hôte en fusionnant avec les champs existants (ne les efface pas). */
async function putHost(net, octet, patch) {
  const cur = (state.data.ips[net] || {})[String(octet)] || {};
  const body = {
    state: patch.state != null ? patch.state : (cur.state || "static"),
    name: patch.name != null ? patch.name : (cur.name || ""),
    desc: patch.desc != null ? patch.desc : (cur.desc || ""),
    mac: patch.mac != null ? patch.mac : (cur.mac || ""),
    piece: patch.piece != null ? patch.piece : (cur.piece || ""),
    tailscale: patch.tailscale != null ? patch.tailscale : (cur.tailscale || ""),
    type: patch.type != null ? patch.type : (cur.type || "autre"),
  };
  await api.put(`/api/networks/${net}/hosts/${octet}`, body);
}

// ═══════════════════════════════════ RENDU ═════════════════════════════════

function render() {
  if (state.needAuth) {
    app.innerHTML = renderLogin();
    shownTab = null; shownModal = null;
    const box = document.getElementById("nm-pwd");
    if (box) box.focus();
    return;
  }
  if (state.loadError) {
    app.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--ink-soft)">
      <div><i class="ph ph-wifi-slash" style="font-size:40px;color:var(--danger)"></i>
      <div style="margin-top:12px;font-size:15px">Impossible de contacter le serveur NetMap.</div>
      <div style="margin-top:6px;font-size:13px">${esc(state.loadError)}</div>
      <button data-act="retry" style="${btnPrimary};margin:16px auto 0">Réessayer</button></div></div>`;
    shownTab = null; shownModal = null;
    return;
  }
  animTab = shownTab !== state.activeTab;
  animModal = shownModal !== state.modal;
  shownTab = state.activeTab;
  shownModal = state.modal;

  app.innerHTML =
    `<div style="min-height:100vh;background:var(--bg);color:var(--ink);font-family:'Hanken Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased">` +
    renderHeader() +
    `<main style="max-width:1120px;margin:0 auto;padding:clamp(16px,3vw,28px) clamp(14px,4vw,32px) 80px">` +
    (state.activeTab === "plan" ? renderPlan()
      : state.activeTab === "conn" ? renderConn()
      : renderPorts()) +
    `</main>` +
    renderModals() +
    `</div>`;

  if (state.scrollTo) {
    const el = document.getElementById(state.scrollTo);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    state.scrollTo = null;
  }
}

// ────────────────────────────── Écran de connexion ─────────────────────────
function renderLogin() {
  return `
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg)">
    <form data-act="loginForm" style="width:100%;max-width:360px;background:var(--surface);border:1px solid var(--line-strong);border-radius:16px;box-shadow:var(--shadow);padding:26px;animation:nmpop .2s ease">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--ocre);color:var(--on-ocre);display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow)">${logoMark(25)}</div>
        <div style="line-height:1.05">
          <div style="font-family:'Spectral',serif;font-weight:700;font-size:23px;letter-spacing:-.01em">Net<span style="color:var(--ocre)">Map</span></div>
          <div style="font-size:11px;color:var(--ink-soft);font-weight:500">Gestion d'adressage réseau</div>
        </div>
      </div>
      <label style="${lbl}" for="nm-pwd">Mot de passe</label>
      <input id="nm-pwd" type="password" autocomplete="current-password" placeholder="••••••••"
             style="${inp};margin-bottom:${state.authError ? "10px" : "18px"}">
      ${state.authError ? `<div style="display:flex;align-items:center;gap:7px;margin-bottom:16px;font-size:12.5px;color:var(--danger)">
        <i class="ph ph-warning-circle" style="font-size:15px"></i>${esc(state.authError)}</div>` : ""}
      <button type="submit" ${state.authBusy ? "disabled" : ""} style="${btnSave};width:100%;padding:12px;justify-content:center${state.authBusy ? ";opacity:.6;cursor:default" : ""}">
        ${state.authBusy ? "Connexion…" : "Se connecter"}</button>
      <p style="margin:14px 0 0;font-size:11px;color:var(--ink-soft);text-align:center">
        La connexion reste enregistrée sur cet appareil.</p>
    </form>
  </div>`;
}

function renderHeader() {
  const themeIcon = state.theme === "dark" ? "ph-sun" : "ph-moon-stars";
  const themeLabel = state.theme === "dark" ? "Clair" : "Sombre";
  return `
  <header style="position:sticky;top:0;z-index:20;background:color-mix(in srgb, var(--bg) 88%, transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)">
    <div style="max-width:1120px;margin:0 auto;padding:14px clamp(14px,4vw,32px);display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:12px;margin-right:auto">
        <div style="width:36px;height:36px;border-radius:9px;background:var(--ocre);color:var(--on-ocre);display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow)">
          ${logoMark(23)}
        </div>
        <div style="line-height:1.05">
          <div style="font-family:'Spectral',serif;font-weight:700;font-size:22px;letter-spacing:-.01em">Net<span style="color:var(--ocre)">Map</span></div>
          <div style="font-size:11px;color:var(--ink-soft);font-weight:500;letter-spacing:.02em">Gestion d'adressage réseau</div>
        </div>
      </div>
      <button data-act="toggleTheme" style="display:flex;align-items:center;gap:8px;padding:9px 13px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-weight:600;font-size:13px;cursor:pointer">
        <i class="ph ${themeIcon}" style="font-size:16px"></i><span>${themeLabel}</span>
      </button>
      ${state.authRequired ? `<button data-act="logout" title="Se déconnecter de cet appareil" style="display:flex;align-items:center;gap:8px;padding:9px 13px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink-soft);font-weight:600;font-size:13px;cursor:pointer">
        <i class="ph ph-sign-out" style="font-size:16px"></i><span>Déconnexion</span></button>` : ""}
    </div>
    <div class="nm-scroll" style="max-width:1120px;margin:0 auto;padding:0 clamp(14px,4vw,32px);display:flex;gap:4px;overflow-x:auto">
      <button data-act="tab" data-tab="plan" style="${tabStyle(state.activeTab === "plan")}"><i class="ph ph-list-numbers" style="font-size:17px"></i><span>Plan d'adressage</span></button>
      <button data-act="tab" data-tab="conn" style="${tabStyle(state.activeTab === "conn")}"><i class="ph ph-wifi-high" style="font-size:17px"></i><span>État de connexion</span></button>
      <button data-act="tab" data-tab="ports" style="${tabStyle(state.activeTab === "ports")}"><i class="ph ph-plugs-connected" style="font-size:17px"></i><span>Ports &amp; services</span></button>
    </div>
  </header>`;
}

function emptyNetworksCard(msg) {
  return `<div style="padding:44px;text-align:center;color:var(--ink-soft);border:1px dashed var(--line-strong);border-radius:14px;background:var(--surface)">
    <i class="ph ph-stack" style="font-size:34px;color:var(--ink-soft)"></i>
    <div style="margin-top:12px;font-size:15px;color:var(--ink)">${esc(msg)}</div>
    <button data-act="addNetwork" style="${btnPrimary};margin:16px auto 0"><i class="ph ph-plus" style="font-size:16px"></i>Créer mon premier réseau</button>
  </div>`;
}

// ─────────────────────────── Onglet 1 : Plan ───────────────────────────────
function renderPlan() {
  const net = currentNet();
  if (!net) return `<section style="${animSection()}">${emptyNetworksCard("Aucun réseau pour l'instant.")}</section>`;

  const ipmap = state.data.ips[net.id] || {};
  let cFree = 0, cStatic = 0, cDhcp = 0;
  for (let o = 1; o <= 254; o++) {
    const st = (ipmap[o] || {}).state || "free";
    if (st === "static") cStatic++; else if (st === "dhcp") cDhcp++; else cFree++;
  }

  const list = planRowsHTML(net);
  const options = state.data.networks
    .map((n) => `<option value="${esc(n.id)}" ${n.id === net.id ? "selected" : ""}>${esc(n.name + "  ·  " + n.base + ".0/" + n.mask)}</option>`)
    .join("");

  return `
  <section style="${animSection()}">
    <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:18px">
      <div style="flex:1 1 260px">
        <label style="display:block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:6px">Réseau sélectionné</label>
        <div style="position:relative">
          <i class="ph ph-caret-down" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--ink-soft)"></i>
          <select data-act="selectNetwork" style="width:100%;appearance:none;padding:12px 36px 12px 14px;border-radius:10px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-weight:600;font-size:15px;cursor:pointer">${options}</select>
        </div>
      </div>
      <button data-act="editNetwork" style="${btnGhost}"><i class="ph ph-pencil-simple" style="font-size:16px"></i>Modifier</button>
      <button data-act="addNetwork" style="${btnPrimary}"><i class="ph ph-plus" style="font-size:16px"></i>Ajouter un réseau</button>
      <button data-act="deleteNetwork" style="${btnGhost};color:var(--danger)"><i class="ph ph-trash" style="font-size:16px"></i>Supprimer</button>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:14px 16px;border-radius:12px;background:var(--surface-3);border:1px solid var(--line);margin-bottom:18px">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:600;letter-spacing:-.01em">${esc(net.base + ".0/" + net.mask)}</div>
      <div style="height:22px;width:1px;background:var(--line-strong)"></div>
      <div style="font-size:13px;color:var(--ink-soft)">Plage DHCP&nbsp;&nbsp;<span style="font-family:'IBM Plex Mono',monospace;color:var(--teal);font-weight:600">${esc("." + net.dhcpStart + " – ." + net.dhcpEnd)}</span></div>
      <div style="height:22px;width:1px;background:var(--line-strong)"></div>
      <div style="display:flex;gap:16px;font-size:13px;margin-left:auto">
        <span><b style="font-family:'IBM Plex Mono',monospace">${cFree}</b> <span style="color:var(--ink-soft)">libres</span></span>
        <span><b style="font-family:'IBM Plex Mono',monospace;color:var(--ocre)">${cStatic}</b> <span style="color:var(--ink-soft)">statiques</span></span>
        <span><b style="font-family:'IBM Plex Mono',monospace;color:var(--teal)">${cDhcp}</b> <span style="color:var(--ink-soft)">DHCP</span></span>
      </div>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px">
      <div style="position:relative;flex:1 1 230px;min-width:180px">
        <i class="ph ph-magnifying-glass" style="position:absolute;left:13px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--ink-soft);font-size:15px"></i>
        <input id="nm-plan-search" value="${esc(state.search)}" placeholder="Rechercher : 34, nom, MAC…" autocomplete="off"
               style="width:100%;padding:9px 34px 9px 36px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-size:13.5px">
        <button id="nm-plan-clear" data-act="clearSearch" title="Effacer" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:24px;height:24px;border-radius:999px;border:none;background:var(--surface-3);color:var(--ink-soft);align-items:center;justify-content:center;cursor:pointer;display:${state.search ? "flex" : "none"}"><i class="ph ph-x" style="font-size:12px"></i></button>
      </div>
      <button data-act="filter" data-filter="${state.filter === "used" ? "all" : "used"}" title="N'afficher que les adresses attribuées" style="${chip(state.filter === "used")}">
        <i class="ph ${state.filter === "used" ? "ph-eye-slash" : "ph-eye"}" style="font-size:14px"></i>Masquer les libres</button>
      <button data-act="filter" data-filter="${state.filter === "free" ? "all" : "free"}" title="N'afficher que les adresses disponibles" style="${chip(state.filter === "free")}">
        <i class="ph ph-circle" style="font-size:14px"></i>Libres uniquement</button>
      <span id="nm-plan-count" style="font-size:12.5px;color:var(--ink-soft);white-space:nowrap">${planCountText(list.count)}</span>
    </div>

    <div id="nm-plan-rows" style="border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--surface);box-shadow:var(--shadow)">
      ${list.html}
    </div>
  </section>`;
}

/** Lignes du plan filtrées par l'état (libre / utilisée) puis par la recherche. */
function planRowsHTML(net) {
  const ipmap = state.data.ips[net.id] || {};
  const q = state.search.trim().toLowerCase();
  const rows = [];
  for (let o = 1; o <= 254; o++) {
    const e = ipmap[o] || { state: "free" };
    const st = e.state || "free";
    if (state.filter === "free" && st !== "free") continue;
    if (state.filter === "used" && st === "free") continue;
    if (q && !hostMatches(net, o, e, q)) continue;
    rows.push(planRow(net, o, e, st));
  }
  const empty = q
    ? `Aucune adresse ne correspond à « ${esc(state.search.trim())} ».`
    : "Aucune adresse ne correspond à ce filtre.";
  return {
    count: rows.length,
    html: rows.join("") || `<div style="padding:34px;text-align:center;color:var(--ink-soft)">${empty}</div>`,
  };
}

/** Une recherche « 34 » cible le dernier octet ; « 192.168.1.34 » l'IP entière. */
function hostMatches(net, o, e, q) {
  if (/^\d+$/.test(q)) {
    if (String(o).includes(q)) return true;
  } else if ((net.base + "." + o).includes(q)) {
    return true;
  }
  return [e.name, e.mac, e.desc, e.piece, e.tailscale]
    .some((v) => v && String(v).toLowerCase().includes(q));
}

function planCountText(count) {
  const filtered = state.filter !== "all" || state.search.trim();
  return filtered ? `${count} affichée${count > 1 ? "s" : ""} / 254` : "";
}

/** Rafraîchit uniquement les lignes : la saisie garde le focus et le curseur. */
function refreshPlanRows() {
  const box = document.getElementById("nm-plan-rows");
  const net = currentNet();
  if (!box || !net) return;
  const list = planRowsHTML(net);
  box.innerHTML = list.html;
  const cnt = document.getElementById("nm-plan-count");
  if (cnt) cnt.textContent = planCountText(list.count);
  const clear = document.getElementById("nm-plan-clear");
  if (clear) clear.style.display = state.search ? "flex" : "none";
}

function planRow(net, o, e, st) {
  const key = net.id + "." + o;
  const t = typeOf(e.type);
  const isStatic = st === "static", isDhcp = st === "dhcp", isFree = st === "free";
  const inPool = o >= net.dhcpStart && o <= net.dhcpEnd;
  const name = e.name || (isFree ? "" : "Sans nom");

  const menu = state.menuKey === key ? `
    <div style="position:absolute;top:40px;left:0;z-index:15;width:190px;background:var(--surface-2);border:1px solid var(--line-strong);border-radius:12px;box-shadow:var(--shadow);padding:6px;animation:nmpop .14s ease">
      <button data-act="setState" data-net="${net.id}" data-octet="${o}" data-state="free" style="width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border:none;background:transparent;border-radius:8px;cursor:pointer;color:var(--ink);font-size:13.5px;font-weight:500"><i class="ph ph-circle" style="font-size:16px;color:var(--ink-soft)"></i>Libre</button>
      <button data-act="setState" data-net="${net.id}" data-octet="${o}" data-state="static" style="width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border:none;background:transparent;border-radius:8px;cursor:pointer;color:var(--ink);font-size:13.5px;font-weight:500"><i class="ph ph-lock-simple-fill" style="font-size:16px;color:var(--ocre)"></i>Statique</button>
      <button data-act="setState" data-net="${net.id}" data-octet="${o}" data-state="dhcp" style="width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border:none;background:transparent;border-radius:8px;cursor:pointer;color:var(--ink);font-size:13.5px;font-weight:500"><i class="ph ph-arrows-clockwise" style="font-size:16px;color:var(--teal)"></i>DHCP</button>
    </div>` : "";

  let badge = "";
  if (isFree) badge = `<span style="flex:none;display:inline-flex;align-items:center;gap:6px;padding:4px 11px 4px 9px;border:1.5px solid var(--line-strong);border-radius:999px;color:var(--ink-soft);background:transparent;font-size:12px;font-weight:700;min-width:96px"><i class="ph ph-circle" style="font-size:13px"></i>Libre</span>`;
  else if (isStatic) badge = `<span style="flex:none;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1.5px solid var(--ocre);border-radius:5px;color:var(--on-ocre);background:var(--ocre);font-size:12px;font-weight:700;min-width:96px"><i class="ph ph-lock-simple-fill" style="font-size:13px"></i>Statique</span>`;
  else badge = `<span style="flex:none;display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border:1.5px dashed var(--teal);border-radius:999px;color:var(--teal-ink);background:var(--teal-soft);font-size:12px;font-weight:700;min-width:96px"><i class="ph ph-arrows-clockwise" style="font-size:13px"></i>DHCP</span>`;

  const dstatic = isStatic ? "1" : "";
  const device = !isFree ? `
    <div style="flex:1 1 240px;min-width:0;display:flex;align-items:center;gap:11px">
      <span title="${esc(t.l)}" style="flex:none;width:30px;height:30px;border-radius:8px;background:var(--surface-3);color:var(--ink);display:flex;align-items:center;justify-content:center"><i class="ph ${t.i}" style="font-size:16px"></i></span>
      <div style="min-width:0">
        <button data-act="primary" data-net="${net.id}" data-octet="${o}" data-static="${dstatic}" style="display:block;font-weight:600;font-size:14.5px;color:var(--ink);background:none;border:none;padding:0;cursor:pointer;text-align:left;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</button>
        <div style="font-size:12px;color:var(--ink-soft);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${[
            e.mac ? `<span style="font-family:'IBM Plex Mono',monospace">${esc(e.mac)}</span>` : "",
            e.desc ? `<span style="opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.desc)}</span>` : "",
            e.piece ? `<span style="opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.piece)}</span>` : "",
          ].filter(Boolean).join(`<span style="opacity:.5;font-family:'IBM Plex Mono',monospace">${esc(state.fieldSeparator)}</span>`)}
        </div>
      </div>
    </div>`
    : `<div style="flex:1 1 240px;font-size:13px;color:var(--ink-soft);font-style:italic">Disponible — cliquez pour assigner un appareil</div>`;

  return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:11px 14px;border-top:1px solid var(--line);position:relative">
      <div style="position:relative;flex:none">
        <button data-act="menu" data-key="${key}" title="Changer l'état" style="width:34px;height:34px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink-soft);display:flex;align-items:center;justify-content:center;cursor:pointer">
          <i class="ph ph-dots-three-vertical" style="font-size:18px"></i>
        </button>
        ${menu}
      </div>
      ${badge}
      <div style="flex:none;display:flex;flex-direction:column;gap:1px">
        <button data-act="primary" data-net="${net.id}" data-octet="${o}" data-static="${dstatic}" style="font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600;letter-spacing:-.02em;color:var(--ink);background:none;border:none;padding:2px 4px;cursor:pointer;text-align:left">${esc(net.base + "." + o)}</button>
        ${e.tailscale ? `<span title="IP Tailscale" style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:500;letter-spacing:-.02em;color:var(--ink-soft);opacity:.6;padding:0 4px">${esc(e.tailscale)}</span>` : ""}
      </div>
      ${inPool ? `<span title="Dans la plage DHCP" style="flex:none;font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--teal);border:1px solid var(--teal);border-radius:4px;padding:1px 5px">POOL</span>` : ""}
      ${device}
      <div style="flex:none;display:flex;gap:4px;margin-left:auto">
        <button data-act="editIp" data-net="${net.id}" data-octet="${o}" title="Modifier" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink-soft);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ph ph-pencil-simple" style="font-size:15px"></i></button>
        ${isStatic ? `<button data-act="primary" data-net="${net.id}" data-octet="${o}" data-static="1" title="Voir les ports" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink-soft);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ph ph-plugs-connected" style="font-size:15px"></i></button>` : ""}
      </div>
    </div>`;
}

// ─────────────────────── Onglet 2 : État de connexion ──────────────────────
function scanLineHTML() {
  const sc = state.scan;
  const s = state.settings;
  let main;
  if (sc.isScanning) {
    main = `<i class="ph ph-radioactive" style="font-size:15px;color:var(--accent)"></i> Scan immédiat en cours…`;
  } else if (sc.roundActive) {
    const p = sc.progress || {};
    main = `<i class="ph ph-arrows-clockwise" style="font-size:15px;color:var(--accent)"></i> Tour automatique en cours… ${p.done || 0}/${p.total || 0}${p.currentIp ? " · " + esc(p.currentIp) : ""}`;
  } else if (sc.nextScanAt) {
    const left = sc.nextScanAt - serverNow();
    const txt = left <= 0 ? "imminent" : "dans " + frDur(left);
    main = `<i class="ph ph-timer" style="font-size:15px;color:var(--teal)"></i> Prochain tour automatique ${txt}`;
  } else {
    main = `<i class="ph ph-timer" style="font-size:15px;color:var(--teal)"></i> En attente…`;
  }
  const last = sc.lastFullScanAt ? "il y a " + frDur(serverNow() - sc.lastFullScanAt) : "jamais";
  return `${main}
    <span style="opacity:.5">·</span>
    <span>Intervalle : <b>${esc(s.scanIntervalMinutes)} min</b></span>
    <span style="opacity:.5">·</span>
    <span>Dernier tour : ${last}</span>`;
}

function renderConn() {
  const rows = [];
  state.data.networks.forEach((nw) => {
    const m = state.data.ips[nw.id] || {};
    Object.keys(m).map(Number).sort((a, b) => a - b).forEach((o) => {
      const e = m[o];
      if (e.state === "static" || e.state === "dhcp") rows.push(connCard(nw, o, e));
    });
  });
  // connectés d'abord, puis inconnus, puis déconnectés
  const order = (c) => (c === true ? 0 : c == null ? 1 : 2);

  const hasNet = state.data.networks.length > 0;
  const scanning = state.scan.isScanning;

  return `
  <section style="${animSection()}">
    <div style="margin-bottom:16px">
      <h2 style="font-family:'Spectral',serif;font-weight:600;font-size:clamp(19px,3vw,24px);margin:0 0 4px">État de connexion</h2>
      <p style="margin:0;color:var(--ink-soft);font-size:13.5px">Surveillance automatique par ping ICMP réel : chaque appareil est testé à tour de rôle, puis un nouveau tour a lieu après l'intervalle configuré.</p>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:14px 16px;border-radius:12px;background:var(--surface-3);border:1px solid var(--line);margin-bottom:18px">
      <div id="nm-scanline" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--ink-soft)">${scanLineHTML()}</div>
      <div style="display:flex;gap:8px;margin-left:auto">
        <button data-act="openSettings" style="${btnGhost}"><i class="ph ph-sliders-horizontal" style="font-size:16px"></i>Réglages</button>
        <button data-act="scanNow" ${scanning ? "disabled" : ""} style="${btnPrimary}${scanning ? ";opacity:.6;cursor:default" : ""}"><i class="ph ${scanning ? "ph-circle-notch" : "ph-radar"}" style="font-size:16px"></i>${scanning ? "Scan en cours…" : "Scanner maintenant"}</button>
      </div>
    </div>

    <div style="display:grid;gap:12px">
      ${rows.length
        ? rows.sort((a, b) => order(a.c) - order(b.c)).map((r) => r.html).join("")
        : (hasNet
          ? `<div style="padding:40px;text-align:center;color:var(--ink-soft);border:1px dashed var(--line-strong);border-radius:13px">Aucun appareil en service. Marquez une IP comme <b>Statique</b> ou <b>DHCP</b> dans le Plan d'adressage.</div>`
          : emptyNetworksCard("Aucun réseau pour l'instant."))}
    </div>
  </section>`;
}

function connCard(nw, o, e) {
  const t = typeOf(e.type);
  const conn = e.conn || {};
  const c = conn.connected;           // true | false | null
  const since = conn.since;
  const kind = e.state === "dhcp" ? "DHCP" : "Statique";
  const dur = since ? frDur(serverNow() - since) : "";
  const checked = e.lastChecked ? "vérifié il y a " + frDur(serverNow() - e.lastChecked) : "jamais testé";
  const rtt = e.rtt != null ? " · " + e.rtt + " ms" : "";

  let status;
  if (c === true) {
    status = `<div style="flex:none;display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;background:var(--teal-soft);border:1.5px solid var(--teal);color:var(--teal-ink)">
      <i class="ph-fill ph-circle" style="font-size:11px"></i><span style="font-weight:700;font-size:13px">Connecté</span><span style="font-size:12.5px;opacity:.85">· ${esc(dur)}</span></div>`;
  } else if (c === false) {
    status = `<div style="flex:none;display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:6px;background:transparent;border:1.5px dashed var(--line-strong);color:var(--ink-soft)">
      <i class="ph ph-circle-dashed" style="font-size:14px"></i><span style="font-weight:700;font-size:13px">Déconnecté</span><span style="font-size:12.5px;opacity:.9">· ${esc(dur)}</span></div>`;
  } else {
    status = `<div style="flex:none;display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:8px;background:transparent;border:1.5px dashed var(--line-strong);color:var(--ink-soft)">
      <i class="ph ph-hourglass-medium" style="font-size:14px"></i><span style="font-weight:700;font-size:13px">Non testé</span></div>`;
  }

  const html = `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:13px;background:var(--surface);box-shadow:var(--shadow)">
      <span style="flex:none;width:38px;height:38px;border-radius:9px;background:var(--surface-3);display:flex;align-items:center;justify-content:center"><i class="ph ${t.i}" style="font-size:19px"></i></span>
      <div style="flex:1 1 200px;min-width:0">
        <div style="font-weight:600;font-size:15px">${esc(e.name || "Sans nom")}</div>
        <div style="font-size:12.5px;color:var(--ink-soft);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <span style="font-family:'IBM Plex Mono',monospace">${esc(nw.base + "." + o)}</span>
          <span>·</span><span>${esc(kind)}</span><span>·</span><span>${esc(nw.name)}</span>
          <span>·</span><span>${esc(checked)}${esc(rtt)}</span>
        </div>
      </div>
      ${status}
      <button data-act="pingOne" data-net="${nw.id}" data-octet="${o}" title="Re-tester maintenant" style="flex:none;display:flex;align-items:center;gap:7px;padding:9px 13px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink);font-weight:600;font-size:13px;cursor:pointer"><i class="ph ph-arrow-clockwise" style="font-size:15px"></i>Re-tester</button>
    </div>`;
  return { c, html };
}

// ─────────────────────── Onglet 3 : Ports & services ───────────────────────
function renderPorts() {
  const cards = [];
  state.data.networks.forEach((nw) => {
    const m = state.data.ips[nw.id] || {};
    Object.keys(m).map(Number).sort((a, b) => a - b).forEach((o) => {
      const e = m[o];
      if (e.state === "static") cards.push(deviceCard(nw, o, e));
    });
  });
  const hasNet = state.data.networks.length > 0;

  return `
  <section style="${animSection()}">
    <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:space-between;margin-bottom:18px">
      <div>
        <h2 style="font-family:'Spectral',serif;font-weight:600;font-size:clamp(19px,3vw,24px);margin:0 0 4px">Ports &amp; services par appareil</h2>
        <p style="margin:0;color:var(--ink-soft);font-size:13.5px">Chaque appareil possède une IP statique et ses ports ouverts.</p>
      </div>
      ${hasNet ? `<button data-act="addDevice" style="${btnPrimary}"><i class="ph ph-plus" style="font-size:16px"></i>Ajouter un appareil</button>` : ""}
    </div>
    <div style="display:grid;gap:16px">
      ${cards.join("") || (hasNet
        ? `<div style="padding:44px;text-align:center;color:var(--ink-soft);border:1px dashed var(--line-strong);border-radius:14px">Aucun appareil statique. Ajoutez-en un ou marquez une IP comme <b>Statique</b>.</div>`
        : emptyNetworksCard("Aucun réseau pour l'instant."))}
    </div>
  </section>`;
}

function deviceCard(nw, o, e) {
  const t = typeOf(e.type);
  const key = nw.id + "." + o;
  const anchor = "dev-" + key.replace(/\./g, "-");
  const hl = state.focusedKey === key;
  const ports = e.ports || [];
  const baseCard = "border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--surface);box-shadow:var(--shadow);scroll-margin-top:120px";
  const cardStyle = baseCard + (hl ? ";box-shadow:0 0 0 2px var(--accent),var(--shadow)" : "");

  const portRows = ports.map((p) => `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 17px;border-bottom:1px solid var(--line)">
      <span style="flex:none;min-width:64px;font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600;color:var(--ocre);background:var(--ocre-soft);padding:4px 10px;border-radius:7px;text-align:center">${esc(p.number)}</span>
      <div style="flex:1 1 200px;min-width:0">
        <div style="font-weight:600;font-size:14.5px">${esc(p.title)}</div>
        ${p.desc ? `<div style="font-size:12.5px;color:var(--ink-soft)">${esc(p.desc)}</div>` : ""}
      </div>
      <div style="flex:none;display:flex;gap:4px">
        <button data-act="editPort" data-net="${nw.id}" data-octet="${o}" data-port="${esc(p.id)}" title="Modifier" style="width:30px;height:30px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--ink-soft);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ph ph-pencil-simple" style="font-size:14px"></i></button>
        <button data-act="deletePort" data-port="${esc(p.id)}" title="Supprimer" style="width:30px;height:30px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--danger);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ph ph-x" style="font-size:14px"></i></button>
      </div>
    </div>`).join("");

  return `
    <div id="${anchor}" style="${cardStyle}">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:15px 17px;border-bottom:1px solid var(--line);background:var(--surface-3)">
        <span style="flex:none;width:38px;height:38px;border-radius:9px;background:var(--surface);border:1px solid var(--line);display:flex;align-items:center;justify-content:center"><i class="ph ${t.i}" style="font-size:19px"></i></span>
        <div style="flex:1 1 180px;min-width:0">
          <div style="font-weight:600;font-size:16px">${esc(e.name || "Sans nom")}</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--ink-soft)">${esc(nw.base + "." + o + " · " + nw.name)}</div>
        </div>
        <span style="flex:none;font-size:12px;font-weight:600;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);padding:4px 10px;border-radius:999px">${ports.length} port(s)</span>
        <div style="flex:none;display:flex;gap:4px">
          <button data-act="addPort" data-net="${nw.id}" data-octet="${o}" title="Ajouter un port" style="width:34px;height:34px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ph ph-plus" style="font-size:16px"></i></button>
          <button data-act="removeDevice" data-net="${nw.id}" data-octet="${o}" title="Retirer l'appareil" style="width:34px;height:34px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--danger);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ph ph-trash" style="font-size:15px"></i></button>
        </div>
      </div>
      <div>
        ${portRows || `<div style="padding:16px 17px;font-size:13px;color:var(--ink-soft);font-style:italic">Aucun port renseigné. Utilisez « + » pour en ajouter.</div>`}
      </div>
    </div>`;
}

// ────────────────────────────────── Modals ─────────────────────────────────
function modalShell(inner, maxw = 440) {
  return `<div data-act="backdrop" title="Cliquez à l'extérieur pour enregistrer" style="position:fixed;inset:0;z-index:50;background:rgba(20,15,8,.5);backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;${animModal ? "animation:nmfade .18s ease;" : ""}overflow:auto">
    <div style="width:100%;max-width:${maxw}px;background:var(--surface);border:1px solid var(--line-strong);border-radius:16px;box-shadow:var(--shadow);padding:22px;${animModal ? "animation:nmpop .18s ease" : ""}">${inner}</div></div>`;
}
function modalHead(title) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <h3 style="font-family:'Spectral',serif;font-weight:600;font-size:19px;margin:0">${title}</h3>
    <button data-act="closeModal" style="width:32px;height:32px;border-radius:8px;border:none;background:var(--surface-3);color:var(--ink);cursor:pointer"><i class="ph ph-x"></i></button></div>`;
}
const lbl = "display:block;font-size:12px;font-weight:600;color:var(--ink-soft);margin-bottom:6px";
const inp = "width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink);font-size:14px";
const mono = ";font-family:'IBM Plex Mono',monospace";
const btnCancel = "padding:11px 16px;border-radius:9px;border:1px solid var(--line-strong);background:transparent;color:var(--ink);font-weight:600;cursor:pointer";
const btnSave = "padding:11px 18px;border-radius:9px;border:none;background:var(--accent);color:var(--on-ocre);font-weight:700;cursor:pointer";

/** Pied de modale commun + rappel des raccourcis (clic extérieur = enregistrer). */
function modalFoot(saveAct, saveLabel = "Enregistrer") {
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:flex-end">
    <span style="margin-right:auto;font-size:11px;color:var(--ink-soft)">Clic extérieur = enregistrer · Échap = annuler</span>
    <button data-act="closeModal" style="${btnCancel}">Annuler</button>
    <button data-act="${saveAct}" style="${btnSave}">${saveLabel}</button>
  </div>`;
}

function renderModals() {
  const d = state.draft || {};
  const nets = state.data.networks;
  if (state.modal === "ip") {
    return modalShell(
      modalHead(`Adresse <span style="font-family:'IBM Plex Mono',monospace;color:var(--ocre)">${esc(d.ip)}</span>`) +
      `<label style="${lbl}">État</label>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button data-act="draftState" data-state="free" style="${d.state === "free" ? segOn : segOff}"><i class="ph ph-circle"></i>Libre</button>
        <button data-act="draftState" data-state="static" style="${d.state === "static" ? segOn : segOff}"><i class="ph ph-lock-simple-fill"></i>Statique</button>
        <button data-act="draftState" data-state="dhcp" style="${d.state === "dhcp" ? segOn : segOff}"><i class="ph ph-arrows-clockwise"></i>DHCP</button>
      </div>
      <label style="${lbl}">Nom de l'appareil</label>
      <input data-field="name" value="${esc(d.name)}" placeholder="ex : NAS Synology" style="${inp};margin-bottom:13px">
      <label style="${lbl}">Type d'appareil</label>
      <select data-field="type" style="${inp};margin-bottom:13px">${typeOptions(d.type)}</select>
      <label style="${lbl}">Adresse MAC</label>
      <input data-field="mac" value="${esc(d.mac)}" placeholder="00:11:22:AA:BB:CC" style="${inp}${mono};margin-bottom:13px">
      <label style="${lbl}">IP Tailscale <span style="font-weight:400;color:var(--ink-soft)">(optionnel)</span></label>
      <input data-field="tailscale" value="${esc(d.tailscale)}" placeholder="100.x.y.z" style="${inp}${mono};margin-bottom:13px">
      <label style="${lbl}">Description</label>
      <textarea data-field="desc" rows="2" placeholder="Rôle, service…" style="${inp};resize:vertical;margin-bottom:13px">${esc(d.desc)}</textarea>
      <label style="${lbl}">Pièce</label>
      <input data-field="piece" value="${esc(d.piece)}" placeholder="ex : Cellier, Salon…" style="${inp};margin-bottom:18px">
      ${modalFoot("saveIp")}`);
  }
  if (state.modal === "network" || state.modal === "editNetwork") {
    const edit = state.modal === "editNetwork";
    return modalShell(
      modalHead(edit ? "Modifier le réseau" : "Nouveau réseau") +
      `<label style="${lbl}">Nom du réseau</label>
      <input data-field="name" value="${esc(d.name)}" placeholder="ex : Réseau principal" style="${inp};margin-bottom:13px">
      <div style="display:flex;gap:12px;margin-bottom:13px">
        <div style="flex:2"><label style="${lbl}">Base</label>
          <input data-field="base" value="${esc(d.base)}" placeholder="192.168.1" style="${inp}${mono}"></div>
        <div style="flex:1"><label style="${lbl}">Masque</label>
          <select data-field="mask" style="${inp}">${["24", "25", "26"].map((m) => `<option value="${m}" ${String(d.mask) === m ? "selected" : ""}>/${m}</option>`).join("")}</select></div>
      </div>
      <label style="${lbl}">Plage DHCP (dernier octet)</label>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:18px">
        <span style="color:var(--ink-soft);font-family:'IBM Plex Mono',monospace">de .</span>
        <input data-field="dhcpStart" value="${esc(d.dhcpStart)}" style="width:80px;padding:11px 13px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink);font-size:14px${mono}">
        <span style="color:var(--ink-soft);font-family:'IBM Plex Mono',monospace">à .</span>
        <input data-field="dhcpEnd" value="${esc(d.dhcpEnd)}" style="width:80px;padding:11px 13px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink);font-size:14px${mono}">
      </div>
      ${modalFoot(edit ? "saveEditNetwork" : "saveNetwork", edit ? "Enregistrer" : "Créer le réseau")}`);
  }
  if (state.modal === "device") {
    return modalShell(
      modalHead("Ajouter un appareil") +
      `<p style="margin:0 0 14px;font-size:12.5px;color:var(--ink-soft)">Un appareil ajouté ici reçoit toujours une <b>IP statique</b>.</p>
      <label style="${lbl}">Réseau</label>
      <select data-field="netId" style="${inp};margin-bottom:13px">${nets.map((n) => `<option value="${esc(n.id)}" ${n.id === d.netId ? "selected" : ""}>${esc(n.name + "  ·  " + n.base + ".0/" + n.mask)}</option>`).join("")}</select>
      <div style="display:flex;gap:12px;margin-bottom:13px">
        <div style="flex:1"><label style="${lbl}">Dernier octet</label>
          <input data-field="octet" value="${esc(d.octet)}" placeholder="50" style="${inp}${mono}"></div>
        <div style="flex:1.4"><label style="${lbl}">Type</label>
          <select data-field="type" style="${inp}">${typeOptions(d.type)}</select></div>
      </div>
      <label style="${lbl}">Nom de l'appareil</label>
      <input data-field="name" value="${esc(d.name)}" placeholder="ex : Serveur média" style="${inp};margin-bottom:18px">
      ${modalFoot("saveDevice", "Ajouter")}`);
  }
  if (state.modal === "port") {
    return modalShell(
      modalHead(d.portId ? "Modifier le port" : "Nouveau port") +
      `<label style="${lbl}">Numéro de port</label>
      <input data-field="number" value="${esc(d.number)}" placeholder="8080" style="${inp}${mono};margin-bottom:13px">
      <label style="${lbl}">Programme / service</label>
      <input data-field="title" value="${esc(d.title)}" placeholder="ex : Portainer" style="${inp};margin-bottom:13px">
      <label style="${lbl}">Description</label>
      <textarea data-field="desc" rows="2" placeholder="À quoi sert ce port ?" style="${inp};resize:vertical;margin-bottom:18px">${esc(d.desc)}</textarea>
      ${modalFoot("savePort")}`, 420);
  }
  if (state.modal === "settings") {
    return modalShell(
      modalHead("Réglages de la surveillance") +
      `<label style="${lbl}">⏱️ Intervalle entre deux tours automatiques (minutes)</label>
      <input data-field="scanIntervalMinutes" value="${esc(d.scanIntervalMinutes)}" style="${inp}${mono};margin-bottom:4px">
      <p style="margin:0 0 14px;font-size:11.5px;color:var(--ink-soft)">Temps d'attente une fois tous les appareils testés, avant de recommencer un tour.</p>
      <label style="${lbl}">Délai avant « déconnecté » (secondes)</label>
      <input data-field="pingTimeoutSeconds" value="${esc(d.pingTimeoutSeconds)}" style="${inp}${mono};margin-bottom:14px">
      <label style="${lbl}">Pause entre chaque appareil (secondes)</label>
      <input data-field="pingSpacingSeconds" value="${esc(d.pingSpacingSeconds)}" style="${inp}${mono};margin-bottom:18px">
      ${modalFoot("saveSettings")}`, 460);
  }
  return "";
}

function typeOptions(sel) {
  return [["ordinateur", "Ordinateur"], ["telephone", "Téléphone"], ["serveur", "Serveur"], ["domotique", "Domotique"], ["autre", "Autre"]]
    .map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("");
}

// ═══════════════════════════════ ÉVÉNEMENTS ════════════════════════════════

/** Ouvre une modale avec son brouillon (remis « propre » : rien à enregistrer). */
function openModal(kind, draft) {
  state.modal = kind;
  state.draft = draft;
  state.draftDirty = false;
  state.menuKey = null;
}

// Action d'enregistrement associée à chaque modale (clic à l'extérieur / Entrée).
const MODAL_SAVE = {
  ip: "saveIp", network: "saveNetwork", editNetwork: "saveEditNetwork",
  device: "saveDevice", port: "savePort", settings: "saveSettings",
};

/** Ferme la modale en enregistrant, sauf si aucun champ n'a été touché. */
function commitModal() {
  const save = MODAL_SAVE[state.modal];
  if (save && state.draftDirty) { actions[save](); return; }
  actions.closeModal();
}

app.addEventListener("change", (e) => {
  const t = e.target;
  const act = t.dataset && t.dataset.act;
  if (act === "selectNetwork") { state.currentNetworkId = t.value; state.menuKey = null; render(); return; }
  const f = t.dataset && t.dataset.field;
  if (f) { state.draft[f] = t.value; state.draftDirty = true; }
});

// Saisie en direct : le brouillon reste à jour même sans quitter le champ
// (indispensable pour l'enregistrement au clic à l'extérieur).
app.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "nm-plan-search") { state.search = t.value; refreshPlanRows(); return; }
  const f = t.dataset && t.dataset.field;
  if (f) { state.draft[f] = t.value; state.draftDirty = true; }   // pas de re-rendu : le focus est préservé
});

// Écran de connexion : « Entrée » comme le bouton, sans recharger la page.
app.addEventListener("submit", (e) => {
  if (e.target.dataset.act !== "loginForm") return;
  e.preventDefault();
  actions.login();
});

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) { if (state.menuKey) { state.menuKey = null; render(); } return; }
  const a = el.dataset.act;
  if (a === "backdrop") { if (e.target === el) commitModal(); return; }
  const h = actions[a];
  if (h) h(el.dataset, el);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.modal) actions.closeModal();        // Échap = annuler explicitement
    else if (state.menuKey) { state.menuKey = null; render(); }
    return;
  }
  // Entrée dans un champ d'une seule ligne : enregistre (les zones de texte
  // gardent le retour à la ligne).
  if (e.key === "Enter" && state.modal && e.target.tagName === "INPUT") {
    e.preventDefault();
    const save = MODAL_SAVE[state.modal];
    if (save) actions[save]();
  }
});

const actions = {
  retry() { boot(); },

  async login() {
    if (state.authBusy) return;
    const box = document.getElementById("nm-pwd");
    const password = box ? box.value : "";
    state.authBusy = true; state.authError = null; render();
    try {
      const r = await api.post("/api/login", { password });
      setToken(r.token);
      state.authBusy = false;
      state.needAuth = false;
      await boot();
    } catch (err) {
      state.authBusy = false;
      state.authError = err.message || String(err);
      render();
    }
  },
  logout() {
    if (!confirm("Se déconnecter de cet appareil ?")) return;
    state.authError = null;
    forceLogin();
  },
  tab(d) { state.activeTab = d.tab; state.menuKey = null; render(); },
  toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", state.theme);
    try { localStorage.setItem("netmap.theme", state.theme); } catch (e) {}
    render();
  },
  filter(d) { state.filter = d.filter; render(); },
  clearSearch() {
    state.search = "";
    render();
    const box = document.getElementById("nm-plan-search");
    if (box) box.focus();
  },
  menu(d) { state.menuKey = state.menuKey === d.key ? null : d.key; render(); },
  closeModal() { state.modal = null; state.draftDirty = false; render(); },

  async setState(d) {
    state.menuKey = null;
    try {
      if (d.state === "free") await api.del(`/api/networks/${d.net}/hosts/${d.octet}`);
      else await putHost(d.net, Number(d.octet), { state: d.state });
      await reload();
    } catch (err) { alert("Erreur : " + err.message); }
    render();
  },

  editIp(d) {
    const net = state.data.networks.find((n) => n.id === d.net);
    const e = ((state.data.ips[d.net] || {})[d.octet]) || { state: "free" };
    openModal("ip", {
      netId: d.net, o: Number(d.octet),
      ip: (net ? net.base : "") + "." + d.octet,
      name: e.name || "", desc: e.desc || "", mac: e.mac || "",
      piece: e.piece || "", tailscale: e.tailscale || "",
      type: e.type || "ordinateur",
      state: e.state && e.state !== "free" ? e.state : "static",
    });
    render();
  },
  draftState(d) { state.draft.state = d.state; state.draftDirty = true; render(); },

  primary(d) {
    if (d.static === "1") {
      state.activeTab = "ports";
      state.focusedKey = d.net + "." + d.octet;
      state.scrollTo = "dev-" + (d.net + "." + d.octet).replace(/\./g, "-");
      state.menuKey = null;
      render();
    } else {
      actions.editIp(d);
    }
  },

  async saveIp() {
    const d = state.draft;
    try {
      if (d.state === "free") await api.del(`/api/networks/${d.netId}/hosts/${d.o}`);
      else await api.put(`/api/networks/${d.netId}/hosts/${d.o}`, {
        state: d.state, name: (d.name || "").trim(), desc: (d.desc || "").trim(),
        mac: (d.mac || "").trim(), piece: (d.piece || "").trim(),
        tailscale: (d.tailscale || "").trim(), type: d.type,
      });
      await reload(); state.modal = null; state.draftDirty = false;
    } catch (err) { alert("Erreur : " + err.message); }
    render();
  },

  addNetwork() { openModal("network", { name: "", base: "192.168.", mask: "24", dhcpStart: "100", dhcpEnd: "200" }); render(); },
  editNetwork() {
    const n = currentNet(); if (!n) return;
    openModal("editNetwork", { id: n.id, name: n.name, base: n.base, mask: String(n.mask), dhcpStart: String(n.dhcpStart), dhcpEnd: String(n.dhcpEnd) });
    render();
  },
  async saveNetwork() {
    const d = state.draft;
    if (!(d.name || "").trim() || !(d.base || "").trim()) { alert("Nom et base requis."); return; }
    try {
      const r = await api.post("/api/networks", {
        name: d.name.trim(), base: d.base.trim().replace(/\.$/, ""),
        mask: parseInt(d.mask) || 24, dhcpStart: parseInt(d.dhcpStart) || 100, dhcpEnd: parseInt(d.dhcpEnd) || 200,
      });
      await reload(); state.currentNetworkId = r.id; state.modal = null; state.draftDirty = false;
    } catch (err) { alert("Erreur : " + err.message); }
    render();
  },
  async saveEditNetwork() {
    const d = state.draft;
    try {
      await api.put(`/api/networks/${d.id}`, {
        name: d.name.trim(), base: d.base.trim().replace(/\.$/, ""),
        mask: parseInt(d.mask) || 24, dhcpStart: parseInt(d.dhcpStart) || 100, dhcpEnd: parseInt(d.dhcpEnd) || 200,
      });
      await reload(); state.modal = null; state.draftDirty = false;
    } catch (err) { alert("Erreur : " + err.message); }
    render();
  },
  async deleteNetwork() {
    const n = currentNet(); if (!n) return;
    if (!confirm(`Supprimer le réseau « ${n.name} » et toutes ses adresses ?`)) return;
    try { await api.del(`/api/networks/${n.id}`); await reload(); } catch (err) { alert("Erreur : " + err.message); }
    render();
  },

  addDevice() { openModal("device", { netId: state.currentNetworkId, octet: "", name: "", type: "serveur" }); render(); },
  async saveDevice() {
    const d = state.draft; const o = parseInt(d.octet);
    if (!(o >= 1 && o <= 254)) { alert("Dernier octet invalide (1–254)."); return; }
    try {
      await api.put(`/api/networks/${d.netId}/hosts/${o}`, {
        state: "static", name: (d.name || "").trim() || "Sans nom", type: d.type, desc: "", mac: "",
      });
      await reload();
      state.modal = null; state.draftDirty = false; state.activeTab = "ports";
      state.focusedKey = d.netId + "." + o;
      state.scrollTo = "dev-" + (d.netId + "." + o).replace(/\./g, "-");
    } catch (err) { alert("Erreur : " + err.message); }
    render();
  },
  async removeDevice(d) {
    const e = (state.data.ips[d.net] || {})[d.octet] || {};
    if (!confirm(`Retirer l'appareil « ${e.name || ""} » ? L'IP redevient libre.`)) return;
    try { await api.del(`/api/networks/${d.net}/hosts/${d.octet}`); await reload(); } catch (err) { alert("Erreur : " + err.message); }
    render();
  },

  addPort(d) { openModal("port", { netId: d.net, o: Number(d.octet), portId: null, number: "", title: "", desc: "" }); render(); },
  editPort(d) {
    const e = (state.data.ips[d.net] || {})[d.octet] || {};
    const p = (e.ports || []).find((x) => x.id === d.port);
    if (!p) return;
    openModal("port", { netId: d.net, o: Number(d.octet), portId: p.id, number: p.number, title: p.title, desc: p.desc || "" });
    render();
  },
  async savePort() {
    const d = state.draft;
    if (!String(d.number).trim() || !String(d.title).trim()) { alert("Numéro et service requis."); return; }
    try {
      if (d.portId) await api.put(`/api/ports/${d.portId}`, { number: String(d.number).trim(), title: d.title.trim(), desc: (d.desc || "").trim() });
      else await api.post(`/api/networks/${d.netId}/hosts/${d.o}/ports`, { number: String(d.number).trim(), title: d.title.trim(), desc: (d.desc || "").trim() });
      await reload(); state.modal = null; state.draftDirty = false;
    } catch (err) { alert("Erreur : " + err.message); }
    render();
  },
  async deletePort(d) {
    try { await api.del(`/api/ports/${d.port}`); await reload(); } catch (err) { alert("Erreur : " + err.message); }
    render();
  },

  // Surveillance
  async scanNow() {
    state.scan.isScanning = true; render();
    try { await api.post("/api/scan"); await reload(); } catch (err) { alert("Erreur : " + err.message); }
    render();
  },
  async pingOne(d) {
    try { await api.post(`/api/networks/${d.net}/hosts/${d.octet}/ping`); await reload(); } catch (err) { alert("Erreur : " + err.message); }
    render();
  },
  openSettings() {
    const s = state.settings;
    openModal("settings", { scanIntervalMinutes: s.scanIntervalMinutes, pingTimeoutSeconds: s.pingTimeoutSeconds, pingSpacingSeconds: s.pingSpacingSeconds });
    render();
  },
  async saveSettings() {
    const d = state.draft;
    try {
      await api.put("/api/settings", {
        scanIntervalMinutes: parseFloat(d.scanIntervalMinutes),
        pingTimeoutSeconds: parseFloat(d.pingTimeoutSeconds),
        pingSpacingSeconds: parseFloat(d.pingSpacingSeconds),
      });
      await reload(); state.modal = null; state.draftDirty = false;
    } catch (err) { alert("Erreur : " + err.message); }
    render();
  },
};

// ────────────────────────── Rafraîchissement live ──────────────────────────
// Sondage régulier : met à jour les données et rafraîchit l'onglet connexion
// (sauf si un menu / une modale est ouvert, pour ne pas gêner l'utilisateur).
setInterval(async () => {
  if (state.needAuth || state.authBusy) return;      // écran de connexion : rien à sonder
  try {
    await reload();
    if (state.activeTab === "conn" && !state.modal && !state.menuKey) render();
  } catch (e) {
    if (e.status === 401) forceLogin();              // mot de passe changé côté serveur
    /* sinon : réseau momentanément indisponible, on réessaiera */
  }
}, 3000);

// Compte à rebours du prochain tour : mise à jour légère chaque seconde.
setInterval(() => {
  if (state.activeTab !== "conn" || state.modal) return;
  const line = document.getElementById("nm-scanline");
  if (line) line.innerHTML = scanLineHTML();
}, 1000);

// ──────────────────────────────── Démarrage ────────────────────────────────
async function boot() {
  try {
    await reload();
    state.needAuth = false;
    state.loadError = null;
    render();
  } catch (err) {
    // 401 : pas (ou plus) de jeton valable sur cet appareil → écran de connexion.
    if (err.status === 401) { forceLogin(); return; }
    state.loadError = err.message || String(err);
    render();
  }
}
boot();
