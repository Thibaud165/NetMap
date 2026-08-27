"""
Accès aux données : construction du snapshot rendu par le frontend et
opérations CRUD sur réseaux / hôtes / ports.

Le snapshot reprend exactement la forme attendue par l'interface :
    { networks: [...], ips: { netId: { octet: {...} } } }
"""
import uuid

from .database import get_db, now_ms


def _uid(prefix: str = "id") -> str:
    return prefix + uuid.uuid4().hex[:10]


# ─────────────────────────── Snapshot complet ──────────────────────────────

def snapshot() -> dict:
    with get_db() as conn:
        networks = [
            {
                "id": r["id"],
                "name": r["name"],
                "base": r["base"],
                "mask": r["mask"],
                "dhcpStart": r["dhcp_start"],
                "dhcpEnd": r["dhcp_end"],
            }
            for r in conn.execute(
                "SELECT * FROM networks ORDER BY position, created_at"
            ).fetchall()
        ]

        ports_by_host: dict[str, list] = {}
        # Numéro croissant : `number` est du texte, on trie donc sur sa valeur
        # numérique (sinon « 8080 » passerait avant « 443 »).
        for p in conn.execute(
            "SELECT * FROM ports ORDER BY CAST(number AS INTEGER), number, rowid"
        ).fetchall():
            ports_by_host.setdefault(p["host_id"], []).append(
                {
                    "id": p["id"],
                    "number": p["number"],
                    "title": p["title"],
                    "desc": p["description"],
                }
            )

        ips: dict[str, dict] = {n["id"]: {} for n in networks}
        for h in conn.execute("SELECT * FROM hosts").fetchall():
            net_id = h["network_id"]
            if net_id not in ips:
                continue
            ips[net_id][str(h["octet"])] = {
                "state": h["state"],
                "name": h["name"],
                "desc": h["description"],
                "mac": h["mac"],
                "piece": h["piece"],
                "tailscale": h["tailscale"],
                "type": h["type"],
                "conn": {
                    "connected": (None if h["conn_connected"] is None
                                  else bool(h["conn_connected"])),
                    "since": h["conn_since"],
                },
                "lastChecked": h["last_checked"],
                "rtt": h["rtt_ms"],
                "ports": ports_by_host.get(h["id"], []),
            }
    return {"networks": networks, "ips": ips}


# ─────────────────────────────── Réseaux ───────────────────────────────────

def create_network(name, base, mask=24, dhcp_start=100, dhcp_end=200) -> str:
    nid = _uid("n")
    with get_db() as conn:
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM networks"
        ).fetchone()["p"]
        conn.execute(
            "INSERT INTO networks(id, name, base, mask, dhcp_start, dhcp_end, "
            "position, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (nid, name, base, mask, dhcp_start, dhcp_end, pos, now_ms()),
        )
    return nid


def update_network(nid, **fields) -> bool:
    cols = {
        "name": "name", "base": "base", "mask": "mask",
        "dhcpStart": "dhcp_start", "dhcpEnd": "dhcp_end",
    }
    sets, vals = [], []
    for k, col in cols.items():
        if k in fields and fields[k] is not None:
            sets.append(f"{col} = ?")
            vals.append(fields[k])
    if not sets:
        return False
    vals.append(nid)
    with get_db() as conn:
        cur = conn.execute(
            f"UPDATE networks SET {', '.join(sets)} WHERE id = ?", vals
        )
    return cur.rowcount > 0


def delete_network(nid) -> bool:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM networks WHERE id = ?", (nid,))
    return cur.rowcount > 0


# ──────────────────────────────── Hôtes ────────────────────────────────────

def upsert_host(net_id, octet, state="static", name="", desc="", mac="",
                piece="", tailscale="", type_="autre") -> str | None:
    """Crée ou met à jour une adresse assignée. state 'free' => on la libère."""
    if state == "free":
        delete_host(net_id, octet)
        return None
    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM hosts WHERE network_id = ? AND octet = ?",
            (net_id, octet),
        ).fetchone()
        if row:
            hid = row["id"]
            conn.execute(
                "UPDATE hosts SET state=?, name=?, description=?, mac=?, "
                "piece=?, tailscale=?, type=? WHERE id=?",
                (state, name, desc, mac, piece, tailscale, type_, hid),
            )
        else:
            hid = _uid("h")
            conn.execute(
                "INSERT INTO hosts(id, network_id, octet, state, name, "
                "description, mac, piece, tailscale, type, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (hid, net_id, octet, state, name, desc, mac, piece, tailscale,
                 type_, now_ms()),
            )
    return hid


def delete_host(net_id, octet) -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM hosts WHERE network_id = ? AND octet = ?",
            (net_id, octet),
        )
    return cur.rowcount > 0


# ──────────────────────────────── Ports ────────────────────────────────────

def _host_id(conn, net_id, octet):
    row = conn.execute(
        "SELECT id FROM hosts WHERE network_id = ? AND octet = ?",
        (net_id, octet),
    ).fetchone()
    return row["id"] if row else None


def add_port(net_id, octet, number, title, desc="") -> str | None:
    with get_db() as conn:
        hid = _host_id(conn, net_id, octet)
        if not hid:
            return None
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ports WHERE host_id=?",
            (hid,),
        ).fetchone()["p"]
        pid = _uid("p")
        conn.execute(
            "INSERT INTO ports(id, host_id, number, title, description, position) "
            "VALUES (?,?,?,?,?,?)",
            (pid, hid, number, title, desc, pos),
        )
    return pid


def update_port(port_id, number, title, desc="") -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE ports SET number=?, title=?, description=? WHERE id=?",
            (number, title, desc, port_id),
        )
    return cur.rowcount > 0


def delete_port(port_id) -> bool:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM ports WHERE id = ?", (port_id,))
    return cur.rowcount > 0


# ─────────────────────────── Cibles de ping ────────────────────────────────

def list_ping_targets() -> list[dict]:
    """Toutes les adresses assignées (statique ou DHCP) = appareils à surveiller."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT h.id, h.name, h.conn_connected, h.conn_since, n.base, h.octet "
            "FROM hosts h JOIN networks n ON n.id = h.network_id "
            "ORDER BY n.position, h.octet"
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "ip": f'{r["base"]}.{r["octet"]}',
            "prev_connected": r["conn_connected"],
            "prev_since": r["conn_since"],
        }
        for r in rows
    ]


def get_ping_target(net_id, octet) -> dict | None:
    with get_db() as conn:
        r = conn.execute(
            "SELECT h.id, h.conn_connected, h.conn_since, n.base, h.octet "
            "FROM hosts h JOIN networks n ON n.id = h.network_id "
            "WHERE h.network_id = ? AND h.octet = ?",
            (net_id, octet),
        ).fetchone()
    if not r:
        return None
    return {
        "id": r["id"],
        "ip": f'{r["base"]}.{r["octet"]}',
        "prev_connected": r["conn_connected"],
        "prev_since": r["conn_since"],
    }


def apply_ping_result(host_id, alive: bool, rtt_ms, now: int,
                      prev_connected, prev_since):
    """Enregistre le résultat d'un ping. `conn_since` ne change que si le
    statut a basculé, ce qui permet d'afficher « connecté depuis X »."""
    changed = (prev_connected is None) or (bool(prev_connected) != alive)
    since = now if changed else (prev_since or now)
    with get_db() as conn:
        conn.execute(
            "UPDATE hosts SET conn_connected=?, conn_since=?, last_checked=?, "
            "rtt_ms=? WHERE id=?",
            (1 if alive else 0, since, now, rtt_ms, host_id),
        )
