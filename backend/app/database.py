"""
Couche base de données SQLite.

SQLite est parfait pour un Raspberry Pi toujours allumé : un seul fichier,
aucun serveur séparé, robuste. Le fichier vit dans un volume Docker (/data),
il survit donc aux redémarrages et à `docker-compose down`.

La base démarre **vide** : aucun réseau, aucune adresse. Tout est créé par
l'utilisateur depuis l'interface.
"""
import os
import sqlite3
import time
import threading
from contextlib import contextmanager

from . import config

_lock = threading.Lock()


def now_ms() -> int:
    return int(time.time() * 1000)


SCHEMA = """
CREATE TABLE IF NOT EXISTS networks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    base        TEXT NOT NULL,
    mask        INTEGER NOT NULL DEFAULT 24,
    dhcp_start  INTEGER NOT NULL DEFAULT 100,
    dhcp_end    INTEGER NOT NULL DEFAULT 200,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hosts (
    id             TEXT PRIMARY KEY,
    network_id     TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    octet          INTEGER NOT NULL,
    state          TEXT NOT NULL DEFAULT 'static',   -- 'static' | 'dhcp'
    name           TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    mac            TEXT NOT NULL DEFAULT '',
    piece          TEXT NOT NULL DEFAULT '',   -- pièce / emplacement
    tailscale      TEXT NOT NULL DEFAULT '',   -- IP Tailscale (optionnelle)
    type           TEXT NOT NULL DEFAULT 'autre',
    conn_connected INTEGER,          -- NULL = jamais testé, sinon 0/1
    conn_since     INTEGER,          -- ms : depuis quand le statut actuel dure
    last_checked   INTEGER,          -- ms : dernier ping
    rtt_ms         REAL,             -- dernier temps de réponse
    created_at     INTEGER NOT NULL,
    UNIQUE(network_id, octet)
);

CREATE TABLE IF NOT EXISTS ports (
    id          TEXT PRIMARY KEY,
    host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    number      TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosts_net ON hosts(network_id);
CREATE INDEX IF NOT EXISTS idx_ports_host ON ports(host_id);
"""


@contextmanager
def get_db():
    """Connexion SQLite courte, sérialisée par un verrou (charge très faible)."""
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        with _lock:
            yield conn
            conn.commit()
    finally:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(config.DB_PATH) or ".", exist_ok=True)
    with get_db() as conn:
        conn.executescript(SCHEMA)
        # Migrations : ajoute les colonnes ajoutées après coup aux bases existantes.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(hosts)")}
        if "piece" not in cols:
            conn.execute(
                "ALTER TABLE hosts ADD COLUMN piece TEXT NOT NULL DEFAULT ''"
            )
        if "tailscale" not in cols:
            conn.execute(
                "ALTER TABLE hosts ADD COLUMN tailscale TEXT NOT NULL DEFAULT ''"
            )
        # Seed des réglages runtime depuis les valeurs par défaut de l'environnement
        for key, val in config.RUNTIME_SETTING_DEFAULTS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                (key, str(val)),
            )


def get_setting(key: str, default=None):
    with get_db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
    return row["value"] if row else default


def get_setting_int(key: str, default: int) -> int:
    try:
        return int(float(get_setting(key, default)))
    except (TypeError, ValueError):
        return default


def get_setting_float(key: str, default: float) -> float:
    try:
        return float(get_setting(key, default))
    except (TypeError, ValueError):
        return default


def set_setting(key: str, value):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
