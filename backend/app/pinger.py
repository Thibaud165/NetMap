"""
Moteur de surveillance réseau.

Deux modes, exactement comme demandé :

1. TOUR AUTOMATIQUE (round-robin) — en tâche de fond
   • ping chaque appareil « chacun son tour »
   • une pause de PING_SPACING_SECONDS (1 s) entre chaque appareil
   • s'il ne répond pas avant PING_TIMEOUT_SECONDS (10 s) → « déconnecté »
   • une fois tous les appareils testés, on attend SCAN_INTERVAL_MINUTES
     (30 min par défaut) puis on recommence un tour.

2. SCAN IMMÉDIAT (bouton « Scanner maintenant ») — à la demande
   • ping TOUS les appareils EN MÊME TEMPS (le plus vite possible).
"""
import asyncio
import logging

from icmplib import async_ping, async_multiping
from icmplib.exceptions import SocketPermissionError, NameLookupError

from . import config, repo
from .database import get_setting_float, now_ms

log = logging.getLogger("netmap.pinger")

IDLE_RESCAN_SECONDS = 15  # ré-évalue vite tant qu'aucun appareil n'existe


class PingEngine:
    def __init__(self):
        self._task: asyncio.Task | None = None
        self._stop = False
        self._privileged = config.PING_PRIVILEGED

        # État exposé à l'interface
        self._scanning = False           # scan manuel en cours
        self._round_active = False       # tour automatique en cours
        self._last_full_scan_at: int | None = None
        self._last_pass_end: int = now_ms()
        self._next_scan_at: int | None = None
        self._progress = {"done": 0, "total": 0, "currentIp": None}

    # ─────────────────────────── cycle de vie ──────────────────────────────

    def start(self):
        self._stop = False
        self._task = asyncio.create_task(self._loop())
        log.info("Moteur de ping démarré (privileged=%s)", self._privileged)

    async def stop(self):
        self._stop = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    # ────────────────────────────── pings ──────────────────────────────────

    async def _ping(self, ip: str, timeout: int):
        """Renvoie (alive, rtt_ms|None). S'adapte si les pings privilégiés
        ne sont pas autorisés (utile en local hors Docker)."""
        try:
            host = await async_ping(
                ip, count=config.PING_COUNT, timeout=timeout,
                privileged=self._privileged,
            )
            return host.is_alive, (round(host.avg_rtt, 1) if host.is_alive else None)
        except SocketPermissionError:
            # Bascule vers l'autre mode et réessaie une fois
            self._privileged = not self._privileged
            log.warning("Permission ICMP refusée, bascule privileged=%s",
                        self._privileged)
            try:
                host = await async_ping(
                    ip, count=config.PING_COUNT, timeout=timeout,
                    privileged=self._privileged,
                )
                return host.is_alive, (round(host.avg_rtt, 1) if host.is_alive else None)
            except Exception as e:  # noqa: BLE001
                log.error("Ping %s impossible : %s", ip, e)
                return False, None
        except NameLookupError:
            return False, None
        except Exception as e:  # noqa: BLE001
            log.debug("Ping %s a échoué : %s", ip, e)
            return False, None

    async def _apply(self, tgt, alive, rtt, now):
        repo.apply_ping_result(
            tgt["id"], alive, rtt, now,
            tgt["prev_connected"], tgt["prev_since"],
        )

    # ─────────────────────── tour automatique ──────────────────────────────

    @staticmethod
    def _label(tgt) -> str:
        """« 192.168.1.10 (NAS Synology) » — pour des logs lisibles."""
        name = (tgt.get("name") or "").strip()
        return f'{tgt["ip"]} ({name})' if name else tgt["ip"]

    async def _one_pass(self) -> int:
        targets = repo.list_ping_targets()
        self._progress = {"done": 0, "total": len(targets), "currentIp": None}
        self._round_active = True
        awake = 0
        try:
            spacing = get_setting_float("ping_spacing_seconds",
                                      config.PING_SPACING_SECONDS)
            timeout = get_setting_float("ping_timeout_seconds",
                                      config.PING_TIMEOUT_SECONDS)
            if targets:
                log.info("Tour de scan : %d appareil(s) à tester", len(targets))
            for i, tgt in enumerate(targets):
                if self._stop:
                    break
                self._progress["currentIp"] = tgt["ip"]
                alive, rtt = await self._ping(tgt["ip"], timeout)
                prev = tgt["prev_connected"]        # None=jamais testé, 0/1 sinon
                if alive:
                    awake += 1
                    change = " (de retour en ligne)" if prev == 0 else ""
                    log.info("  [UP]   %s - en ligne (%s ms)%s",
                             self._label(tgt), rtt, change)
                else:
                    change = " (vient de se déconnecter)" if prev == 1 else ""
                    log.info("  [DOWN] %s - pas de réponse%s",
                             self._label(tgt), change)
                await self._apply(tgt, alive, rtt, now_ms())
                self._progress["done"] = i + 1
                if i < len(targets) - 1:
                    await asyncio.sleep(max(0, spacing))
        finally:
            self._round_active = False
            self._progress["currentIp"] = None
        if targets:
            self._last_full_scan_at = now_ms()
            interval = get_setting_float("scan_interval_minutes",
                                       config.SCAN_INTERVAL_MINUTES)
            log.info("Tour terminé : %d/%d en ligne. Prochain tour dans %g min.",
                     awake, len(targets), interval)
        return len(targets)

    async def _loop(self):
        await asyncio.sleep(2)  # laisse le serveur finir de démarrer
        while not self._stop:
            try:
                count = await self._one_pass()
            except Exception as e:  # noqa: BLE001
                log.exception("Erreur pendant le tour automatique : %s", e)
                count = 0
            self._last_pass_end = now_ms()

            # Attente avant le prochain tour. Recalculée en continu pour que
            # tout changement du réglage prenne effet immédiatement.
            while not self._stop:
                if count == 0:
                    self._next_scan_at = self._last_pass_end + IDLE_RESCAN_SECONDS * 1000
                else:
                    interval = get_setting_float("scan_interval_minutes",
                                               config.SCAN_INTERVAL_MINUTES)
                    self._next_scan_at = self._last_pass_end + interval * 60_000
                if now_ms() >= self._next_scan_at:
                    break
                await asyncio.sleep(1)

    # ─────────────────────── scan immédiat (bouton) ────────────────────────

    async def scan_now(self) -> dict:
        if self._scanning:
            return {"ok": False, "reason": "already_scanning"}
        self._scanning = True
        try:
            targets = repo.list_ping_targets()
            total = len(targets)
            self._progress = {"done": 0, "total": total, "currentIp": "tous"}
            if not targets:
                self._last_full_scan_at = now_ms()
                self._last_pass_end = self._last_full_scan_at
                return {"ok": True, "count": 0}

            timeout = get_setting_float("ping_timeout_seconds",
                                      config.PING_TIMEOUT_SECONDS)
            ips = [t["ip"] for t in targets]
            try:
                hosts = await async_multiping(
                    ips, count=config.PING_COUNT, timeout=timeout,
                    privileged=self._privileged,
                )
            except SocketPermissionError:
                self._privileged = not self._privileged
                hosts = await async_multiping(
                    ips, count=config.PING_COUNT, timeout=timeout,
                    privileged=self._privileged,
                )

            now = now_ms()
            awake = 0
            for tgt, host in zip(targets, hosts):
                rtt = round(host.avg_rtt, 1) if host.is_alive else None
                if host.is_alive:
                    awake += 1
                await self._apply(tgt, host.is_alive, rtt, now)
            log.info("Scan immédiat : %d/%d en ligne", awake, total)

            self._last_full_scan_at = now
            self._last_pass_end = now  # le scan compte comme un tour complet
            self._progress = {"done": total, "total": total, "currentIp": None}
            return {"ok": True, "count": total}
        finally:
            self._scanning = False

    async def ping_host(self, nid: str, octet: int) -> dict:
        """Re-teste un seul appareil à la demande (bouton par carte)."""
        tgt = repo.get_ping_target(nid, octet)
        if not tgt:
            return {"ok": False, "reason": "not_found"}
        timeout = get_setting_float("ping_timeout_seconds",
                                    config.PING_TIMEOUT_SECONDS)
        alive, rtt = await self._ping(tgt["ip"], timeout)
        await self._apply(tgt, alive, rtt, now_ms())
        log.info("Test manuel %s : %s", self._label(tgt),
                 f"en ligne ({rtt} ms)" if alive else "pas de réponse")
        return {"ok": True, "alive": alive, "rtt": rtt}

    # ─────────────────────────── état pour l'UI ────────────────────────────

    def status(self) -> dict:
        return {
            "isScanning": self._scanning,
            "roundActive": self._round_active,
            "privileged": self._privileged,
            "lastFullScanAt": self._last_full_scan_at,
            "nextScanAt": self._next_scan_at,
            "progress": self._progress,
        }


engine = PingEngine()
