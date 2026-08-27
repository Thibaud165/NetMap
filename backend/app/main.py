"""
NetMap — API REST + service de l'interface web.

Un seul conteneur sert à la fois l'API (/api/...) et le frontend statique.
Accessible en local (http://IP-du-pi:8000) et via Tailscale
(http://100.x.y.z:8000) grâce au mode réseau « host » du docker-compose.
"""
import asyncio
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, repo
from .database import init_db, now_ms, set_setting, get_setting_float
from .pinger import engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("netmap")


class _AccessLogFilter(logging.Filter):
    """Masque le bruit du sondage régulier de l'UI dans les access logs.
    Le frontend appelle /api/data toutes les 3 s : sans ce filtre, ces lignes
    noient les logs utiles (scans, modifications). Les autres requêtes
    (POST /api/scan, PUT hosts…) restent visibles."""

    _NOISY = ("/api/data", "/api/health", "/assets/", "/favicon")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(p in msg for p in self._NOISY)


logging.getLogger("uvicorn.access").addFilter(_AccessLogFilter())

FRONTEND_DIR = "/app/frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log.info("Base de données prête : %s", config.DB_PATH)
    if auth.enabled():
        log.info("🔐 Accès protégé par mot de passe (NETMAP_PASSWORD).")
    else:
        log.warning("⚠️  Aucun mot de passe configuré : l'interface est "
                    "accessible à tout le réseau. Renseignez NETMAP_PASSWORD "
                    "dans le fichier .env pour la protéger.")
    engine.start()
    yield
    await engine.stop()


app = FastAPI(title="NetMap", version="1.0.0", lifespan=lifespan)


# ───────────────────────────── Authentification ────────────────────────────
# Routes d'API accessibles sans jeton (le reste exige l'en-tête Authorization).
PUBLIC_PATHS = {"/api/login", "/api/health"}

# Anti-force brute, en mémoire : au-delà de MAX_TRIES échecs, l'adresse est
# mise en pause pendant LOCKOUT_SECONDS.
MAX_TRIES, LOCKOUT_SECONDS = 8, 300
_failures: dict[str, tuple[int, float]] = {}


def _too_many_tries(ip: str) -> bool:
    tries, last = _failures.get(ip, (0, 0.0))
    if tries < MAX_TRIES:
        return False
    if time.time() - last > LOCKOUT_SECONDS:
        _failures.pop(ip, None)
        return False
    return True


@app.middleware("http")
async def require_token(request: Request, call_next):
    path = request.url.path
    if auth.enabled() and path.startswith("/api/") and path not in PUBLIC_PATHS:
        header = request.headers.get("Authorization", "")
        token = header[7:].strip() if header.startswith("Bearer ") else ""
        if not auth.check_token(token):
            return JSONResponse({"detail": "Authentification requise"}, 401)
    return await call_next(request)


class LoginIn(BaseModel):
    password: str = ""


@app.post("/api/login")
async def login(body: LoginIn, request: Request):
    if not auth.enabled():
        return {"token": "", "required": False}

    ip = request.client.host if request.client else "?"
    if _too_many_tries(ip):
        raise HTTPException(429, "Trop de tentatives. Réessayez dans 5 minutes.")

    if not auth.check_password(body.password):
        tries = _failures.get(ip, (0, 0.0))[0] + 1
        _failures[ip] = (tries, time.time())
        log.warning("Mot de passe refusé depuis %s (tentative %d)", ip, tries)
        await asyncio.sleep(1)          # ralentit les tentatives automatisées
        raise HTTPException(401, "Mot de passe incorrect")

    _failures.pop(ip, None)
    log.info("Connexion réussie depuis %s", ip)
    return {"token": auth.token(), "required": True}


# ───────────────────────────── Modèles d'entrée ────────────────────────────

class NetworkIn(BaseModel):
    name: str
    base: str
    mask: int = 24
    dhcpStart: int = 100
    dhcpEnd: int = 200


class NetworkPatch(BaseModel):
    name: str | None = None
    base: str | None = None
    mask: int | None = None
    dhcpStart: int | None = None
    dhcpEnd: int | None = None


class HostIn(BaseModel):
    state: str = "static"                 # 'static' | 'dhcp' | 'free'
    name: str = ""
    desc: str = ""
    mac: str = ""
    piece: str = ""
    tailscale: str = ""
    type: str = "autre"


class PortIn(BaseModel):
    number: str
    title: str
    desc: str = ""


class SettingsIn(BaseModel):
    scanIntervalMinutes: float | None = Field(default=None, gt=0)
    pingTimeoutSeconds: float | None = Field(default=None, gt=0)
    pingSpacingSeconds: float | None = Field(default=None, ge=0)


# ─────────────────────────────── Helpers ───────────────────────────────────

def _settings_payload() -> dict:
    return {
        "scanIntervalMinutes": get_setting_float("scan_interval_minutes",
                                                 config.SCAN_INTERVAL_MINUTES),
        "pingTimeoutSeconds": get_setting_float("ping_timeout_seconds",
                                                config.PING_TIMEOUT_SECONDS),
        "pingSpacingSeconds": get_setting_float("ping_spacing_seconds",
                                                config.PING_SPACING_SECONDS),
    }


# ─────────────────────────────── Endpoints ─────────────────────────────────

@app.get("/api/data")
def get_data():
    """Instantané complet pour le rendu : réseaux, adresses, réglages, scan."""
    snap = repo.snapshot()
    snap["settings"] = _settings_payload()
    snap["scan"] = engine.status()
    snap["serverNow"] = now_ms()
    snap["fieldSeparator"] = config.FIELD_SEPARATOR
    snap["authRequired"] = auth.enabled()
    return snap


@app.get("/api/settings")
def get_settings():
    return _settings_payload()


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    if body.scanIntervalMinutes is not None:
        set_setting("scan_interval_minutes", body.scanIntervalMinutes)
    if body.pingTimeoutSeconds is not None:
        set_setting("ping_timeout_seconds", body.pingTimeoutSeconds)
    if body.pingSpacingSeconds is not None:
        set_setting("ping_spacing_seconds", body.pingSpacingSeconds)
    return _settings_payload()


# Réseaux ───────────────────────────────────────────────────────────────────

@app.post("/api/networks")
def create_network(body: NetworkIn):
    base = body.base.strip().rstrip(".")
    if not body.name.strip() or not base:
        raise HTTPException(400, "Nom et base requis")
    nid = repo.create_network(body.name.strip(), base, body.mask,
                              body.dhcpStart, body.dhcpEnd)
    return {"id": nid}


@app.put("/api/networks/{nid}")
def update_network(nid: str, body: NetworkPatch):
    fields = body.model_dump(exclude_none=True)
    if "base" in fields:
        fields["base"] = fields["base"].strip().rstrip(".")
    if "name" in fields:
        fields["name"] = fields["name"].strip()
    if not repo.update_network(nid, **fields):
        raise HTTPException(404, "Réseau introuvable ou rien à modifier")
    return {"ok": True}


@app.delete("/api/networks/{nid}")
def delete_network(nid: str):
    if not repo.delete_network(nid):
        raise HTTPException(404, "Réseau introuvable")
    return {"ok": True}


# Hôtes (adresses assignées) ─────────────────────────────────────────────────

@app.put("/api/networks/{nid}/hosts/{octet}")
def upsert_host(nid: str, octet: int, body: HostIn):
    if not (1 <= octet <= 254):
        raise HTTPException(400, "Octet hors plage (1–254)")
    repo.upsert_host(nid, octet, body.state, body.name.strip(),
                     body.desc.strip(), body.mac.strip(),
                     body.piece.strip(), body.tailscale.strip(), body.type)
    return {"ok": True}


@app.delete("/api/networks/{nid}/hosts/{octet}")
def delete_host(nid: str, octet: int):
    repo.delete_host(nid, octet)
    return {"ok": True}


# Ports ──────────────────────────────────────────────────────────────────────

@app.post("/api/networks/{nid}/hosts/{octet}/ports")
def add_port(nid: str, octet: int, body: PortIn):
    if not body.number.strip() or not body.title.strip():
        raise HTTPException(400, "Numéro et service requis")
    pid = repo.add_port(nid, octet, body.number.strip(), body.title.strip(),
                        body.desc.strip())
    if not pid:
        raise HTTPException(404, "Appareil introuvable")
    return {"id": pid}


@app.put("/api/ports/{pid}")
def update_port(pid: str, body: PortIn):
    if not repo.update_port(pid, body.number.strip(), body.title.strip(),
                            body.desc.strip()):
        raise HTTPException(404, "Port introuvable")
    return {"ok": True}


@app.delete("/api/ports/{pid}")
def delete_port(pid: str):
    repo.delete_port(pid)
    return {"ok": True}


# Scan immédiat ──────────────────────────────────────────────────────────────

@app.post("/api/scan")
async def scan_now():
    return await engine.scan_now()


@app.post("/api/networks/{nid}/hosts/{octet}/ping")
async def ping_host(nid: str, octet: int):
    return await engine.ping_host(nid, octet)


@app.get("/api/health")
def health():
    return {"status": "ok", "now": now_ms()}


# ───────────────────────── Frontend statique (en dernier) ───────────────────
# Monté sur "/" APRÈS les routes /api pour que celles-ci aient la priorité.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
