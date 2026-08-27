# NetMap - Gestion et surveillance de l'adressage réseau

Application web auto-hébergée pour cartographier vos réseaux (plan d'adressage, appareils, ports/services) et surveiller automatiquement l'état de connexion de chaque appareil par ping ICMP.

![aperçu](docs/preview.png)

---

## Démarrage rapide

Premier démarrage :

```bash
git clone https://github.com/TON-COMPTE/NetMap.git
cd NetMap
cp .env.example .env            # Créer le fichier .env
nano .env                       # Choisissez un mot de passe pour l'accès à l'app
docker compose up -d --build    # Construire et démarrer l'application
```

Puis ouvrez l'interface :

* Sur le serveur : `http://localhost:8000`
* Depuis un autre appareil du même réseau : `http://ipDuServeur:8000`

Commandes utiles :

```bash
docker compose down            # arrêter
docker compose restart         # redémarrer
docker compose logs -f netmap  # suivre les logs
docker compose up -d           # démarrer après des modifications
```

---

## Réglages principaux

Ces paramètres contrôlent la surveillance automatique. Ils peuvent être définis dans `.env` ou modifiés directement dans **État de connexion › Réglages**.

| Réglage                        | Variable                       |   Défaut | Rôle                                                    |
| ------------------------------ | ------------------------------ | -------: | ------------------------------------------------------- |
| **Intervalle entre les tours** | `NETMAP_SCAN_INTERVAL_MINUTES` |     `30` | Temps d'attente entre deux tours.                       |
| **Délai « déconnecté »**       | `NETMAP_PING_TIMEOUT_SECONDS`  |     `10` | Délai avant de considérer un appareil comme déconnecté. |
| **Pause entre appareils**      | `NETMAP_PING_SPACING_SECONDS`  |      `1` | Pause entre deux appareils pendant un tour.             |
| Port web                       | `NETMAP_PORT`                  |   `8000` | Port de l'interface web.                                |
| **Mot de passe**               | `NETMAP_PASSWORD`              | *(vide)* | Mot de passe d'accès. Vide = aucune authentification.   |
| Séparateur d'infos             | `NETMAP_FIELD_SEPARATOR`       |      `\` | Séparateur entre MAC / Description / Pièce.             |

Les modifications effectuées dans l'interface prennent effet immédiatement et sont enregistrées en base.

---

## Fonctionnalités

* **Réseaux** : nom, base IP, masque (`/24`, `/25`, `/26`) et plage DHCP, entièrement modifiables.
* **Plan d'adressage** : gestion des adresses **Libre / Statique / DHCP**, avec nom, type, MAC et description.
* **Recherche** : par adresse IP, nom d'appareil ou MAC.
* **Masquage des adresses libres** pour faciliter la navigation.
* **Ports et services** : gestion des ports ouverts par appareil statique.
* **Édition rapide** : `Entrée` pour enregistrer, `Échap` ou « Annuler » pour abandonner.
* **Thème clair / sombre**.

---

## Architecture

```text
NetMap/
├── docker-compose.yml     # service Docker, réseau host, CAP_NET_RAW
├── Dockerfile             # image API + interface
├── backend/
│   ├── requirements.txt
│   └── app/
│       ├── main.py        # API REST + frontend
│       ├── auth.py        # authentification
│       ├── config.py      # configuration
│       ├── database.py    # SQLite
│       ├── repo.py        # accès aux données
│       └── pinger.py      # moteur de ping
└── frontend/
    ├── index.html
    └── assets/
        ├── app.js
        ├── app.css
        └── fonts/
```

* **Backend** : Python / FastAPI avec `icmplib` pour les pings.
* **Base de données** : SQLite dans `./data/netmap.db`, persistante entre les redémarrages.
* **Frontend** : HTML/CSS/JS sans dépendance externe ni CDN.

### API REST

| Méthode                   | Route                                   | Rôle                                      |
| ------------------------- | --------------------------------------- | ----------------------------------------- |
| `GET`                     | `/api/data`                             | Récupérer les données et l'état des scans |
| `POST` / `PUT` / `DELETE` | `/api/networks[/{id}]`                  | Gérer les réseaux                         |
| `PUT` / `DELETE`          | `/api/networks/{id}/hosts/{octet}`      | Assigner ou libérer une adresse           |
| `POST` / `PUT` / `DELETE` | `/api/.../ports`, `/api/ports/{id}`     | Gérer les ports                           |
| `POST`                    | `/api/scan`                             | Lancer un scan immédiat                   |
| `POST`                    | `/api/networks/{id}/hosts/{octet}/ping` | Retester un appareil                      |
| `GET` / `PUT`             | `/api/settings`                         | Lire ou modifier les réglages             |
| `POST`                    | `/api/login`                            | Se connecter                              |

Si un mot de passe est configuré, les routes `/api/...` nécessitent un jeton Bearer, sauf `/api/login` et `/api/health`.

---

## Dépannage

### Les appareils sont tous indiqués comme déconnectés

Vérifiez que le conteneur dispose de `NET_RAW` dans `docker-compose.yml` :

```yaml
cap_add:
  - NET_RAW
```

NetMap utilise automatiquement un mode non privilégié si nécessaire.

### L'interface n'est pas accessible depuis un autre appareil

Avec `network_mode: host`, vérifiez le pare-feu :

```bash
sudo ufw allow 8000
```

Vérifiez également l'adresse IP du Pi avec `ip a` ou son adresse Tailscale avec :

```bash
tailscale ip
```

### Docker Desktop (Mac/Windows)

`network_mode: host` est principalement prévu pour Linux et le Raspberry Pi. Sur Mac/Windows, le fonctionnement du réseau et des pings peut différer.

### Déplacer la base de données

Modifiez `NETMAP_DB_PATH` (par défaut : `/data/netmap.db`).

### Mot de passe oublié

Le mot de passe est défini dans `.env`. Modifiez-le puis exécutez :

```bash
docker compose up -d
```

Un `docker compose restart` réinitialise également le compteur d'essais.

### Le mot de passe est redemandé à chaque visite

Le jeton est conservé dans le `localStorage` du navigateur. Il est perdu en navigation privée ou après suppression des données du site.
