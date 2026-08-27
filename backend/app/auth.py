"""
Authentification NetMap : un seul mot de passe partagé, une seule personne
(vous). Pas de comptes, pas de sessions serveur.

Principe :
  1. le navigateur envoie le mot de passe une fois (POST /api/login) ;
  2. le serveur répond un **jeton** dérivé du mot de passe et d'un secret
     tiré au sort au premier démarrage et gardé en base ;
  3. le navigateur mémorise ce jeton (localStorage) et le renvoie sur chaque
     appel d'API.

Le jeton survit donc aux redémarrages du conteneur (le secret est en base),
mais devient invalide dès que le mot de passe change : changer
`NETMAP_PASSWORD` déconnecte tous les appareils.
"""
import hashlib
import hmac
import secrets

from . import config
from .database import get_setting, set_setting

_SECRET_KEY = "auth_secret"
_secret_cache: str | None = None


def enabled() -> bool:
    """Vrai si un mot de passe est configuré (sinon l'accès reste libre)."""
    return bool(config.PASSWORD)


def _secret() -> str:
    """Secret serveur, tiré au sort une fois puis conservé en base."""
    global _secret_cache
    if _secret_cache is None:
        value = get_setting(_SECRET_KEY)
        if not value:
            value = secrets.token_hex(32)
            set_setting(_SECRET_KEY, value)
        _secret_cache = value
    return _secret_cache


def token() -> str:
    """Jeton attendu pour le mot de passe courant."""
    return hmac.new(_secret().encode(), config.PASSWORD.encode(),
                    hashlib.sha256).hexdigest()


def check_password(candidate: str) -> bool:
    # compare_digest : temps constant, pas de fuite par timing.
    return hmac.compare_digest(candidate or "", config.PASSWORD)


def check_token(candidate: str) -> bool:
    return hmac.compare_digest(candidate or "", token())
