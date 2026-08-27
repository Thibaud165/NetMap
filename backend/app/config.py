"""
Configuration NetMap — lue depuis l'environnement (docker-compose).

⚙️  LES VARIABLES LES PLUS IMPORTANTES SONT ICI ⚙️
Elles servent de valeurs *par défaut* et sont copiées dans la base de données
au premier démarrage. Ensuite, elles restent modifiables en direct depuis
l'interface web (onglet « État de connexion » › Réglages).
"""
import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on", "oui")


# ─────────────────────────────────────────────────────────────────────────────
#  ⏱️  RYTHME DES PINGS AUTOMATIQUES  (valeurs par défaut, modifiables ensuite)
# ─────────────────────────────────────────────────────────────────────────────

# Temps d'attente entre deux tours complets de tous les appareils.
# ➜ C'EST LA VARIABLE PRINCIPALE demandée : « on attend 30 min avant de refaire un tour ».
SCAN_INTERVAL_MINUTES = _int("NETMAP_SCAN_INTERVAL_MINUTES", 30)

# Délai avant de déclarer un appareil « déconnecté » s'il ne répond pas.
PING_TIMEOUT_SECONDS = _int("NETMAP_PING_TIMEOUT_SECONDS", 10)

# Pause entre chaque appareil pendant le tour automatique (« chacun leur tour »).
PING_SPACING_SECONDS = _int("NETMAP_PING_SPACING_SECONDS", 1)

# ─────────────────────────────────────────────────────────────────────────────
#  Réglages techniques
# ─────────────────────────────────────────────────────────────────────────────

# Nombre de paquets ICMP envoyés par ping.
PING_COUNT = _int("NETMAP_PING_COUNT", 1)

# Pings privilégiés (raw socket). True fonctionne avec CAP_NET_RAW / root,
# ce que fournit le docker-compose. Mettre à False si vous configurez
# net.ipv4.ping_group_range à la place.
PING_PRIVILEGED = _bool("NETMAP_PING_PRIVILEGED", True)

# 🔐 Mot de passe d'accès à l'interface. Il n'est volontairement PAS écrit
# dans le dépôt : il vient du fichier `.env` (non versionné) que
# docker-compose lit au démarrage. Vide = aucune authentification.
PASSWORD = os.environ.get("NETMAP_PASSWORD", "")

# Emplacement de la base SQLite (monté en volume par docker-compose).
DB_PATH = os.environ.get("NETMAP_DB_PATH", "/data/netmap.db")

# Interface web
HOST = os.environ.get("NETMAP_HOST", "0.0.0.0")
PORT = _int("NETMAP_PORT", 8000)

# Séparateur affiché entre les infos d'un appareil (MAC / Description / Pièce).
# Purement visuel, modifiable dans docker-compose (NETMAP_FIELD_SEPARATOR).
FIELD_SEPARATOR = os.environ.get("NETMAP_FIELD_SEPARATOR", "\\\\\\")


# Réglages exposés/éditables en direct dans l'UI, avec leur valeur par défaut.
RUNTIME_SETTING_DEFAULTS = {
    "scan_interval_minutes": SCAN_INTERVAL_MINUTES,
    "ping_timeout_seconds": PING_TIMEOUT_SECONDS,
    "ping_spacing_seconds": PING_SPACING_SECONDS,
}
