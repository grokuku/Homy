# Contrat d'intégration Docky ↔ Homy

> **Version du contrat :** 1.0 (**accepté et implémenté par Docky le 2026-09-13**)
> **Date :** 2026-09-13
> **Émetteur :** Homy (dashboard self-hosted, dépôt `/projects/Homy`)
> **Destinataire :** équipe/agent qui développe **Docky** (orchestrateur Docker + agents)
> **Statut :** ✅ **accepté et implémenté côté Docky (lots A+B)**. Homy a branché son proxy,
> ses tuiles et ses contrôles sur cette surface (lot 5) — voir l'encadré ci-dessous.
> **Document de référence :** `roadmap.md` §D « Docky (monitoring / santé / contrôles) ».

---

## Réponse de Docky : contrat accepté et implémenté le 2026-09-13

Docky a **accepté le contrat v1.0** et l'a **implémenté** (lots A+B côté Docky). Les points
ouverts §7 ont été tranchés ; voici les **écarts retenus** que Homy applique (lot 5) :

- **Préfixe dédié et versionné** : la surface d'intégration est exposée sous
  **`https://<docky>/api/integration/v1`** (`/api/*` reste réservé à l'UI navigateur de Docky).
  Homy stocke **une seule base URL** configurable ; si l'utilisateur ne saisit que l'hôte, le
  suffixe `/api/integration/v1` est ajouté automatiquement.
- **Clé dédiée** : header `Authorization: Bearer <clé d'intégration>` sur **chaque** requête.
  La clé est **différente de la clé MCP**, gérée dans l'UI Docky (Settings → API d'intégration :
  afficher/copier/régénérer). Côté Homy elle est **côté serveur uniquement** (jamais renvoyée au
  front, jamais journalisée).
- **Vocabulaire normalisé** : `state` ∈ running|exited|paused|restarting|created|dead|unknown ;
  `health` ∈ healthy|unhealthy|starting|none (`null` → `none`). Toute valeur hors liste est
  absorbée comme `unknown`/`none` (jamais de crash d'UI). `{container}` accepte **nom OU id**.
- **`cpu_percent` normalisé hôte 0–100** (`cpu_percent_raw` multi-cœurs + `cpu_count` en plus) ;
  `mem_usage`/`mem_limit`/`mem_percent` en octets/% ; **`mem_usage` exclut DÉJÀ le cache** (ne
  pas re-soustraire `mem_cache`) ; `network_rx`/`network_tx` en **octets cumulés**.
- **`disk_*` toujours `null`** (non mesuré) : Homy affiche « — », jamais une erreur.
- **Batch** : `POST /containers/health` et `POST /containers/stats` (≤ **100 cibles**, corps ≤
  256 Kio, **toujours `200`**) renvoient `{checkedAt, results:[…]}` **dans l'ordre des targets**.
  Un agent injoignable **n'est pas un `502` global** : l'échec est **par cible**
  (`results[i].error = {code, message}`), les champs de la cible en échec restant présents mais
  remis à zéro. Homy découpe lui-même en lots ≤100 et ré-indexe les résultats.
- **`409 conflict` sur une action = succès idempotent** : Homy renvoie l'état cible et affiche
  « déjà dans cet état » plutôt qu'une erreur bloquante.
- **Clé stable** : l'`id` d'un conteneur **change à la recréation** → Homy stocke le **`name`**
  (couple `agent` + `name`) comme identifiant logique.
- **Erreurs** : corps **toujours** `{error, code}` ; `401 unauthorized` (header absent/clé
  invalide), `403 forbidden` (scheme ≠ Bearer), `404 not_found`/`agent_not_found`,
  `409 conflict`, `400 invalid_request` (>100 cibles, corps >256 Kio),
  `502 agent_unreachable`/`action_failed`, `503 agent_offline`/`not_configured`/`no_agents`,
  `504 timeout` (stats 15 s, action 20 s). Homy mappe ces codes sur ses propres états/erreurs.
- **Pas de rate limiting** pour l'instant ; un futur `429` + `Retry-After` est prévu (géré sans en
  dépendre).
- **Non couvert** : action `update-image`, webhooks (intégration *pull*), stats disque.

> Côté Homy (lot 5, FAIT) : client `server/services/docky.service.js`, proxy JWT
> `/api/docky/*`, cache mémoire TTL ~30 s, tuiles santé/monitoring réelles, contrôles
> start/stop/restart avec confirmation 2 temps, sélecteur de cible filtrable et mode dégradé.

---

## 0. L'essentiel (TL;DR)

> Résumé synthétique du contrat. Les **chemins, méthodes HTTP, payloads et formes de réponse
> font foi en §4** ci-dessous (surface attendue par Homy) ; l'**Annexe A** donne la
> correspondance avec les endpoints Docky existants. **Lire la suite du document** pour les cas
> détaillés. Les anciens points ouverts (§7 : préfixe/versionnage, réponses des actions, batch
> stats) ont été **tranchés par Docky** — voir l'encadré « Réponse de Docky » en tête de
> document.

### 0.1 Les endpoints (5 unitaires + 2 batch)

| # | Endpoint (§4) | Rôle | Réponse attendue |
| --- | --- | --- | --- |
| 1 | `GET /api/agents` | Lister les serveurs | `{ agents: [{ name, url, status, version, lastCheck }] }` |
| 2 | `GET /api/agents/{agent}/containers` | Lister les containers d'un agent | `{ agent, containers: [{ id, name, image, state, health, stack, service }] }` |
| 3 | `GET /api/agents/{agent}/containers/{container}` | État + santé d'un container | `{ agent, container, id, name, state, health, checkedAt }` |
| 4 | `POST /api/containers/health` | **État + santé en BATCH — requis** | `{ checkedAt, results: [{ agent, container, found, id, name, state, health, error }] }` |
| 5 | `GET /api/agents/{agent}/containers/{container}/stats` | Ressources d'un container | `{ agent, container, state, health, cpu_percent, mem_usage, mem_limit, mem_percent, network_rx, network_tx, disk_*, checkedAt }` |
| 6 | `POST /api/containers/stats` | Stats en batch *(optionnel, voir §4.6)* | `{ checkedAt, results: [{ …stats…, error }] }` |
| 7 | `POST /api/agents/{agent}/containers/{container}/{start\|stop\|restart}` | **Actions** | `200 { success, agent, container, action, state, health }` ; `202 { success, action, state }` (Q3) |

> `{container}` accepte le **nom ou l'`id`** (cf. §2.2). Les batches (§4.4, §4.6) prennent un
> corps `{ "targets": [{ "agent": …, "container": … }] }` (`POST`), borné à 100 cibles.

> **Le batch santé (n°4) est le point le plus important** : Homy affiche plusieurs tuiles avec
> santé/monitoring et ne peut pas faire 1 requête par container toutes les 30 s.

### 0.2 Vocabulaire normalisé

- **`state`** ∈ `running` · `exited` · `paused` · `restarting` · `created` · `dead` · `unknown`.
- **`health`** ∈ `healthy` · `unhealthy` · `starting` · `none`.
- **Auth** : `Authorization: Bearer <token>` (clé dédiée) ; erreurs `401` / `403`.
- Toute valeur hors liste est absorbée comme **`unknown`** (jamais de crash d'UI).

### 0.3 Codes d'erreur & comportement

| Statut | Cas | Comportement Homy |
| --- | --- | --- |
| `200` / `202` | Succès (synchrone / asynchrone) | État mis à jour (ou « en cours… » si `202`). |
| `400` | Paramètre / action invalide | Toast d'erreur. |
| `401` / `403` | Clé absente/invalide ou IP refusée | « Docky : non autorisé ». |
| `404` | Agent / container inconnu | Santé `unknown` ; action → toast. |
| `409` | Conflit d'état | Toast explicite. |
| `502` | Agent injoignable | État dégradé + toast. |
| `503` | Docky non configuré | Pastille grise, contrôles désactivés. |
| `504` | Timeout agent | État dégradé. |
| `429` | Rate limit | Respecter le `Retry-After`. |

### 0.4 Contraintes de robustesse

- **Timeout par appel** et **réponses rapides** : ne jamais bloquer l'UI de Homy.
- **Actions idempotentes** renvoyant l'**état résultant**.
- **Aucun secret** dans les réponses ni les logs ; pas de dépendance à une URL arbitraire.
- **Cadence Homy ≈ 30 s** avec **cache côté Homy**.

### 0.5 Les 10 points à trancher (Q1 → Q10)

- **Q1 —** Surface d'intégration : orchestrateur agrégé vs endpoints par agent ; clé dédiée vs
  clé MCP existante (`security.mcp_api_key`).
- **Q2 —** Noms/valeurs exacts : `state` vs `status`, `removing`, `health: null` → `none`,
  `id` vs `name`.
- **Q3 —** Réponse des actions : `200` synchrone ou `202` asynchrone.
- **Q4 —** Granularité des stats : `cpu_percent` normalisé hôte (0–100) ou multi-cœurs
  (0–N×100) ?
- **Q5 —** Forme et plafond du batch santé ; batch stats fourni ou non.
- **Q6 —** Disque / réseau prévus et à quelle échéance.
- **Q7 —** Format d'erreur `{error, code}` et statut d'un agent injoignable **dans un batch**.
- **Q8 —** Versionnage / stabilité de l'API d'intégration.
- **Q9 —** Stabilité de l'identifiant container à la recréation.
- **Q10 —** Rate limiting (`429`, en-têtes de quota).

---

## 1. Objet & périmètre

### 1.1 Ce que Homy attend de Docky

Homy est un dashboard « éléments » : chaque élément du catalogue peut viser une **cible Docky**
`{ agent, container }` et afficher, sur sa tuile :

1. **Monitoring par container** — **CPU %** et **RAM** (utilisée / limite / %) en priorité ;
   **disque** et **réseau** en option.
2. **État de santé** — une **pastille** (`health`) et l'**état** du container (`state`).
3. **Contrôles** — actions **`start`** / **`stop`** / **`restart`** par élément, déclenchées
   après une **confirmation utilisateur en 2 temps** côté Homy.

Pour alimenter la **liste déroulante filtrable** de choix de cible, Homy a aussi besoin de
**lister les agents** puis de **lister les containers d'un agent**.

### 1.2 Hors périmètre

Tout le reste est **hors périmètre** de ce contrat. Notamment, Homy n'a **pas besoin** de :

- gestion des **stacks** / compose files / images / registries ;
- **logs**, **exec**, **console**, **terminal** ;
- création / suppression / mise à jour de containers, **update-check**, **prune** ;
- fonctionnalités **MCP** (le serveur MCP Docky est orienté outils LLM, pas ce contrat REST) ;
- authentification utilisateur Docky, gestion de ses utilisateurs, CSRF, etc.

Homy **n'accède jamais à Docker directement** : il ne connaît que l'API Docky.

### 1.3 Point d'entrée « Docky » dans ce contrat

Homy configure **une seule base URL** (`DOCKY_BASE_URL`) et **une seule clé** (`DOCKY_API_KEY`).
Il est donc attendu que Docky expose une **surface d'intégration stable, agrégeant ses agents**,
plutôt que de demander à Homy de connaître chaque URL d'agent et chaque clé d'agent.

> **Point ouvert (§7, Q1)** : le constat est que Docky a aujourd'hui des endpoints **par agent**
> (`/agent/containers/...`) protégés par `DOCKY_AGENT_API_KEY`, et un orchestrateur. Le contrat
> ci-dessous propose une surface **orchestrateur** (`/api/agents/...`, Bearer). Si Docky préfère
> une autre convention (préfixe dédié, version dans l'URL, etc.), elle doit être confirmée —
> seul le **comportement** est ferme, les chemins exacts sont à valider.

---

## 2. Vocabulaire & valeurs normalisées

Homy attend des valeurs **normalisées** (pas de texte libre). Tout ce qui sort de ces listes doit
être absorbé par Homy comme **`unknown`** (jamais de crash d'UI).

### 2.1 `agent`

Un **agent Docky** = un serveur. Identifié par un **`name`** (chaîne stable, choisie dans
Docky). Champs attendus :

| Champ | Type | Obligatoire | Description |
| --- | --- | --- | --- |
| `name` | string | oui | Identifiant stable de l'agent (clé de la cible Homy). |
| `url` | string | non | URL de l'agent (usage interne ; jamais reprise comme URL publique par Homy). |
| `status` | string | oui | `online` \| `offline` \| `unknown`. |
| `version` | string | non | Version de l'agent, si connue. |
| `lastCheck` | string | non | ISO-8601 UTC de la dernière vérification. |

### 2.2 `container`

Un **container** appartient à **un agent**. Docky l'identifie par :

| Champ | Type | Description |
| --- | --- | --- |
| `id` | string | Identifiant court Docker (`short_id`). |
| `name` | string | Nom du container (sans `/` initial). |
| `image` | string | Image (optionnel côté Homy, utile à la liste déroulante). |
| `stack` | string \| null | Stack d'origine (optionnel). |
| `service` | string | Service compose (optionnel). |

La cible Homy stocke **une seule chaîne** `docky.container`. **Recommandation** : stocker le
`name` (lisible et stable au quotidien) et demander à Docky d'accepter **`name` ou `id`** comme
identifiant dans l'URL (comportement déjà vrai du client Docker de l'agent). À confirmer en §7.

### 2.3 `state` — état du container

Valeurs **normalisées attendues** par Homy (issues de l'état Docker, tolérance sur l'inconnu) :

| `state` | Signification | Affichage Homy |
| --- | --- | --- |
| `running` | En cours d'exécution | « Running » |
| `exited` | Arrêté | « Exited » |
| `paused` | En pause | « Paused » |
| `restarting` | En cours de redémarrage | « Restarting » (spinner) |
| `created` | Créé, jamais démarré | « Created » |
| `dead` | État Docker `dead` | « Dead » |
| `unknown` | État illisible / non reconnu | « Unknown » (pastille grise) |

> Docker peut produire d'autres libellés (ex. `removing`). Docky doit soit les **mapper** sur la
> liste ci-dessus, soit les renvoyer tels quels : Homy les traite alors comme **`unknown`**.
> Le mapping exact est un **point ouvert (§7, Q2)**.

### 2.4 `health` — état de santé

Valeurs **normalisées attendues** par Homy :

| `health` | Signification | Pastille Homy |
| --- | --- | --- |
| `healthy` | Healthcheck Docker OK | **verte** |
| `unhealthy` | Healthcheck Docker en échec | **rouge** |
| `starting` | Healthcheck en cours d'initialisation | **orange** (pulsation) |
| `none` | Aucun healthcheck défini sur le container | **grise** (neutre) |

> L'agent Docky renvoie aujourd'hui `health: null` quand il n'y a pas de healthcheck. Le contrat
> attend **`none`** (ou `null`, que Homy lira comme `none`). À figer en §7 (Q2).

### 2.5 Disponibilité des contrôles selon `state`

Homy active/désactive les boutons selon l'état (et Docky renvoie **409** en cas de conflit) :

| `state` | `start` | `stop` | `restart` |
| --- | --- | --- | --- |
| `running` | désactivé | **actif** | **actif** |
| `exited` | **actif** | désactivé | désactivé |
| `created` | **actif** | désactivé | désactivé |
| `paused` | désactivé | **actif** | **actif** |
| `restarting` | désactivé | désactivé (temporaire) | désactivé |
| `dead` | **actif** | désactivé | désactivé |
| `unknown` | désactivé | désactivé | désactivé |

---

## 3. Authentification & transport

### 3.1 Schéma

- **`Authorization: Bearer <token>`** sur **chaque** requête, sans exception.
- Le token est une **clé d'intégration** générée côté Docky. Il peut s'agir de la clé MCP
  existante (`security.mcp_api_key`) ou d'une **clé dédiée** à l'intégration Homy (préférable) —
  **à trancher en §7 (Q1)**.
- Aucun autre mode (cookie, session, query string) n'est accepté. En particulier, **jamais** de
  clé dans l'URL (fuite via logs/historique).

### 3.2 Côté Homy

- La clé et la base URL sont stockées **côté serveur uniquement** (variables d'environnement /
  `config.json`), **jamais** renvoyées au navigateur, **jamais** dans les réponses `/api/docky/*`.
- Le front Homy n'appelle **jamais** Docky directement : tout passe par le **proxy serveur**
  `/api/docky/*` protégé par JWT (voir §8).
- La **base URL est allowlistée** (une seule valeur configurée) : **aucun fetch d'URL arbitraire**
  n'est possible depuis Homy.

### 3.3 Erreurs d'authentification

| Statut | Cas | Corps attendu |
| --- | --- | --- |
| `401` | Token absent, mal formé ou invalide | `{ "error": "Invalid or missing API key", "code": "unauthorized" }` |
| `403` | Token valide mais action non autorisée (ex. agent hors périmètre de la clé) | `{ "error": "Forbidden", "code": "forbidden" }` |

> Docky renvoie déjà `401 {"error": "Invalid or missing API key"}` sur les endpoints d'agent :
> ce format est **conservé** ; `code` est un **ajout** recommandé mais optionnel.

### 3.4 Transport

- **HTTP/1.1 ou HTTP/2**, `Content-Type: application/json` en entrée comme en sortie.
- **HTTPS recommandé** (Docky derrière TLS). Homy accepte `http://` sur réseau privé de confiance.
- **Pas de CORS nécessaire** : les échanges Docky ↔ Homy sont **serveur à serveur**.

---

## 4. Endpoints

### 4.0 Conventions générales

- **Base :** `DOCKY_BASE_URL` (ex. `https://docky.example.tld`), tous les chemins ci-dessous
  relatifs.
- **Réponses succès :** objet JSON direct, **sans enveloppe globale** (sauf mention explicite
  `{ results: [...] }` pour le batch).
- **Réponses erreur :**
  ```json
  { "error": "Human readable message", "code": "machine_code" }
  ```
  `code` est optionnel mais **recommandé** ; `error` est toujours présent.
- **Timestamps :** ISO-8601 UTC (`2026-09-13T12:00:00Z`).
- **Bornes :** tout corps de requête ≤ **256 Ko** ; la liste de cibles d'un batch est bornée
  (proposition : **100 cibles**) et doit renvoyer `400` au-delà.
- **Décimales :** les pourcentages sont des nombres `0..100` avec **2 décimales max** ; les
  tailles sont en **octets** (entiers).

### 4.1 Lister les agents

```
GET /api/agents
Authorization: Bearer <token>
```

**Réponse `200` :**

```json
{
  "agents": [
    { "name": "prod",   "url": "http://agent-prod:8080",  "status": "online",  "version": "1.4.2", "lastCheck": "2026-09-13T12:00:00Z" },
    { "name": "backup", "url": "http://agent-backup:8080", "status": "offline", "version": null,    "lastCheck": "2026-09-13T11:59:30Z" }
  ]
}
```

**Erreurs :** `401`, `403`, `503` (Docky non configuré — aucun agent).

Alignement existant : équivaut à `GET /api/agents` de l'orchestrateur
(`[{ name, url, status }]`) enrichi de `version` / `lastCheck`.

### 4.2 Lister les containers d'un agent

```
GET /api/agents/{agent}/containers
Authorization: Bearer <token>
```

**Réponse `200` :**

```json
{
  "agent": "prod",
  "containers": [
    {
      "id": "3f2a1b9c",
      "name": "web-1",
      "image": "nginx:1.27",
      "state": "running",
      "health": "healthy",
      "stack": "web",
      "service": "web"
    },
    {
      "id": "9c7d0e11",
      "name": "backup-job",
      "image": "restic/restic:latest",
      "state": "exited",
      "health": "none",
      "stack": null,
      "service": ""
    }
  ]
}
```

**Champs obligatoires par container :** `id`, `name`, `state`. Les autres sont optionnels mais
utiles à la liste déroulante.

**Erreurs :** `401`, `403`, `404` agent inconnu, `502` agent injoignable, `504` timeout.

Alignement existant : `GET /api/agents/{name}/containers` (orchestrateur) /
`GET /agent/containers` (agent). L'agent renvoie déjà `id`, `name`, `image`, `status`, `state`,
`health`, `stack`, `service` — le contrat demande en plus que **`health: null` soit normalisé en
`"none"`** et que `state` respecte §2.3.

### 4.3 État + santé d'un container (unitaire)

```
GET /api/agents/{agent}/containers/{container}
Authorization: Bearer <token>
```

**Réponse `200` :**

```json
{
  "agent": "prod",
  "container": "web-1",
  "id": "3f2a1b9c",
  "name": "web-1",
  "state": "running",
  "health": "healthy",
  "checkedAt": "2026-09-13T12:00:00Z"
}
```

**Erreurs :** `401`, `403`, `404` (agent ou container inconnu), `502`, `504`.

> `{container}` accepte le **nom ou l'id** (cf. §2.2).

### 4.4 État + santé d'un lot de containers (batch — **requis**)

Homy rafraîchit **plusieurs tuiles à la fois** : il ne doit pas déclencher N requêtes HTTP par
cycle. Cet endpoint est donc **obligatoire**.

```
POST /api/containers/health
Authorization: Bearer <token>
Content-Type: application/json

{
  "targets": [
    { "agent": "prod", "container": "web-1" },
    { "agent": "prod", "container": "db" },
    { "agent": "backup", "container": "restic" }
  ]
}
```

**Réponse `200`** (totale, même si certaines cibles échouent : l'erreur est **par cible**) :

```json
{
  "checkedAt": "2026-09-13T12:00:00Z",
  "results": [
    { "agent": "prod",   "container": "web-1", "found": true,  "id": "3f2a1b9c", "name": "web-1",  "state": "running", "health": "healthy", "error": null },
    { "agent": "prod",   "container": "db",    "found": false, "id": null,       "name": null,     "state": "unknown", "health": "none",    "error": { "code": "not_found", "message": "Container not found" } },
    { "agent": "backup", "container": "restic","found": false, "id": null,       "name": null,     "state": "unknown", "health": "none",    "error": { "code": "agent_unreachable", "message": "Agent is unreachable" } }
  ]
}
```

**Règles :**

- L'ordre des `results` **suit** l'ordre des `targets` (facilite l'appariement côté Homy).
- `agent` et `container` sont **recopiés tels quels** depuis la requête.
- Une cible inconnue → `found: false` + `state: "unknown"` + `error.code: "not_found"`.
- Un agent injoignable → **HTTP `200`** quand d'autres cibles répondent, avec
  `error.code: "agent_unreachable"` **pour cette cible** seulement.
- Si **tout** Docky est injoignable, Homy reçoit une erreur de transport et bascule en mode
  dégradé (voir §5).
- Bornes : **≤ 100 targets**, corps **≤ 256 Ko** → `400` au-delà.
- `POST` est utilisé pour porter une liste structurée de cibles, mais l'opération est
  **en lecture seule** (pas d'effet de bord).

### 4.5 Statistiques d'un container

```
GET /api/agents/{agent}/containers/{container}/stats
Authorization: Bearer <token>
```

**Réponse `200` :**

```json
{
  "agent": "prod",
  "container": "web-1",
  "state": "running",
  "health": "healthy",
  "cpu_percent": 12.34,
  "mem_usage": 268435456,
  "mem_limit": 1073741824,
  "mem_percent": 25.0,
  "network_rx": 1048576,
  "network_tx": 524288,
  "disk_usage": null,
  "disk_limit": null,
  "disk_percent": null,
  "checkedAt": "2026-09-13T12:00:00Z"
}
```

**Champs fermes :** `cpu_percent`, `mem_usage`, `mem_limit`, `mem_percent`.
**Champs optionnels :** `network_rx`, `network_tx` (octets cumulés), `disk_*` (non encore fourni
par Docky). Tout champ absent est affiché « — » par Homy, sans erreur.

**Unités & normalisation :**

- `cpu_percent` : pourcentage. **À préciser** (Q4) : normalisé hôte (0–100) ou multi-cœurs
  (0–N×100). L'agent actuel multiplie par le nombre de vCPU → peut dépasser 100.
- `mem_usage` / `mem_limit` : **octets**. `mem_percent` : `0..100`.
- `checkedAt` : instant du relevé (snapshot).

**Erreurs :** `401`, `403`, `404` (container inconnu), `502` (agent injoignable), `504`.
Container arrêté : Homy attend `200` avec des compteurs à `0` plutôt qu'une erreur.

Alignement existant : `GET /agent/containers/{container_id}/stats` renvoie déjà
`cpu_percent`, `mem_usage`, `mem_limit`, `mem_percent`, `network_rx`, `network_tx`.

### 4.6 Statistiques d'un lot de containers (batch — **optionnel**)

Souhaitable pour la même raison que §4.4 (plusieurs tuiles monitoring à la fois) :

```
POST /api/containers/stats
{ "targets": [ { "agent": "prod", "container": "web-1" } ] }
```

→ `200` `{ "checkedAt": "...", "results": [ { ...stats..., "error": null } ] }`.

Si Docky ne fournit pas ce batch, Homy fera des appels unitaires bornés (pool de concurrence),
mais le batch est **recommandé**. Statut à confirmer en §7 (Q5).

### 4.7 Actions `start` / `stop` / `restart`

Une action = une méthode + un chemin par verbe.

```
POST /api/agents/{agent}/containers/{container}/start
POST /api/agents/{agent}/containers/{container}/stop
POST /api/agents/{agent}/containers/{container}/restart
Authorization: Bearer <token>
Content-Type: application/json
```

**Corps :** vide (ou `{}`). Les actions sont **par élément**, jamais en lot.

**Réponse `200`** (action acceptée/exécutée) :

```json
{
  "success": true,
  "agent": "prod",
  "container": "web-1",
  "action": "restart",
  "state": "running",
  "health": "starting"
}
```

`state` / `health` renvoyés permettent à Homy de mettre à jour la tuile **immédiatement** (sans
attendre le prochain cycle). Si Docky ne peut pas les fournir, les renvoyer à `null` est accepté.

**Réponse `202`** (action asynchrone acceptée) : `{ "success": true, "action": "restart", "state": "restarting" }`
— Homy rafraîchira au cycle suivant. À trancher en §7 (Q3).

**Erreurs :**

| Statut | Cas | Corps |
| --- | --- | --- |
| `404` | Agent/container inconnu | `{ "error": "Container not found", "code": "not_found" }` |
| `409` | Conflit d'état (ex. `start` sur un container déjà `running`) | `{ "error": "Container is already running", "code": "conflict", "state": "running" }` |
| `502` | Agent injoignable | `{ "error": "Agent is unreachable", "code": "agent_unreachable" }` |
| `504` | Timeout de l'action | `{ "error": "Action timed out", "code": "timeout" }` |
| `503` | Docky non configuré | `{ "error": "Docky is not configured", "code": "not_configured" }` |

> **Changement demandé vs existant :** aujourd'hui l'agent renvoie `200 { "success": false }`
> même en cas d'échec (container introuvable, conflit). Le contrat demande des **statuts HTTP
> porteurs de sens** (`404` / `409` / `502` / `504`). C'est nécessaire pour que Homy affiche le
> bon message et distingue « action impossible » de « Docky en panne ».

**Idempotence :** `start` sur un container déjà démarré doit être **sans danger**. Docky peut
répondre soit `200` (no-op), soit `409` (conflit d'état). Homy gère les deux : sur `409`, il
considère l'état cible comme déjà atteint et **ne montre pas d'erreur bloquante**.

### 4.8 Cadence attendue & cache

- **Rafraîchissement Homy :** boucle **~30 s** par tuile visible (état/santé et stats), avec
  **cache côté Homy** (TTL **~25–30 s**). Les tuiles hors écran/onglet inactif ne sont pas
  rafraîchies.
- **Conséquence Docky :** les réponses doivent être **rapides et bon marché** pour un appel
  toutes les ~30 s et par tuile ; un **batch** est le moyen privilégié.
- Docky peut **mettre en cache** en interne (ex. stats) tant que la fraîcheur reste de l'ordre
  de quelques secondes. Homy tiendra compte de `checkedAt` fourni par Docky.

---

## 5. Codes d'erreur & cas dégradés

### 5.1 Tableau des statuts HTTP et comportement de Homy

| Statut | Sens | Comportement Homy |
| --- | --- | --- |
| `200` | OK | Affiche valeurs / résultat. |
| `202` | Action asynchrone acceptée | Affiche l'état renvoyé (`restarting`) et rafraîchit au cycle suivant. |
| `400` | Requête invalide (corps malformé, > 100 cibles, > 256 Ko) | Erreur de configuration ; log serveur, tuile en erreur discrète. |
| `401` | Token absent/invalide | **Docky mal configuré** côté Homy : mode dégradé + log ; jamais de secret affiché. |
| `403` | Non autorisé | Idem `401` (erreur de configuration/permissions). |
| `404` | Agent ou container inconnu | Tuile : état **`unknown`**, monitoring « — », pastille **grise** ; pas de crash. |
| `409` | Conflit d'état sur une action | Traité comme **déjà dans l'état cible** (ou message non bloquant). |
| `502` | **Agent injoignable** (Docky joint mais ne peut pas atteindre l'agent) | Tuile dégradée `unreachable` + message ; contrôles désactivés pour cet élément. |
| `503` | **Docky non configuré** (pas d'agent / intégration désactivée) | Mode **stub dégradé** global (pastille grise, « — », contrôles désactivés). |
| `504` | **Timeout** (Docky ou agent ne répond pas) | Tuile dégradée `timeout` + message ; réessai au cycle suivant. |
| `5xx` autre | Erreur Docky inattendue | Mode dégradé générique, log serveur ; jamais de fuite d'erreur brute au front. |

### 5.2 Docky totalement absent / non configuré

- Côté Homy, si `DOCKY_BASE_URL` / `DOCKY_API_KEY` sont **vides** → **Docky non configuré** :
  - **aucun appel réseau** n'est tenté ;
  - `GET /api/docky/status` renvoie `{ "configured": false, "reachable": false, "mode": "degraded" }` ;
  - pastille **grise**, monitoring **« — »**, **contrôles désactivés** (roadmap §D.4).
- Si la base URL est configurée mais que Docky est **injoignable** : même rendu dégradé, avec en
  plus un **message** (une seule fois, pas de spam) et un `status.reachable = false`.

### 5.3 États intermédiaires

- `state: "restarting"` ou `health: "starting"` → Homy affiche une **animation/spinner** et
  **désactive temporairement les contrôles** ; le cycle suivant stabilise l'état.
- Après une action renvoyant `202`, Homy affiche l'état intermédiaire fourni et reprend son
  cycle normal (~30 s). Pas de « polling serré » côté Homy.

### 5.4 Récapitulatif du rendu de repli

| Situation | Pastille | Monitoring | Contrôles |
| --- | --- | --- | --- |
| `health: healthy` | verte | valeurs | actifs selon §2.5 |
| `health: unhealthy` | rouge | valeurs | actifs selon §2.5 |
| `health: starting` | orange (pulsation) | valeurs | temporairement désactivés |
| `health: none` | grise (neutre) | valeurs | actifs selon §2.5 |
| `state: unknown` / container inconnu | grise | « — » | désactivés |
| Docky absent / non configuré / injoignable | grise | « — » | désactivés |
| Élément sans cible Docky | *pas de pastille* | *pas de monitoring* | *pas de contrôles* |

---

## 6. Contraintes de robustesse

### 6.1 Timeouts

- Homy applique un **timeout sortant par requête** (proposition : **8 s**, aligné sur les autres
  proxys Homy ; **10 s pour le batch**). Docky doit répondre **bien avant**.
- Cible de latence : **< 1 s** (état/santé), **< 2–3 s** (stats, selon l'hôte).
- Docky doit lui-même appliquer un **timeout court** vers ses agents (le client Docky utilise
  déjà `5 s` pour le ping) et renvoyer `502`/`504` plutôt que de bloquer indéfiniment.

### 6.2 Idempotence des actions

- Les actions doivent être **sûres à réessayer** : `start`/`stop`/`restart` sur un container déjà
  dans l'état cible ne doivent pas provoquer d'incohérence.
- Format accepté : `200` no-op **ou** `409` conflit. Homy tolère les deux.
- Pas de file d'attente infinie ni de double exécution en cas de retry réseau.

### 6.3 Performance & robustesse

- **Batch** pour état/santé (requis) et pour les stats (recommandé) : Homy rafraîchit plusieurs
  tuiles par cycle.
- **Pas de blocage de l'UI Homy** : tous les appels passent par le proxy serveur avec timeout ;
  aucune requête Docky ne doit pouvoir figer le rendu du dashboard.
- **Erreurs partielles** : un agent en panne ne doit **pas** faire échouer tout le batch
  (§4.4). Dégrader **par cible**, pas globalement.
- **Bornes strictes** : ≤ 100 cibles par batch, corps ≤ 256 Ko, réponses raisonnables (pas de
  dump complet d'inspection Docker).

### 6.4 Sécurité

- **Bearer obligatoire** partout ; **secrets jamais dans les réponses ni les logs**.
- Docky ne doit **jamais** renvoyer le token, la clé d'agent, ni un secret d'intégration dans
  une réponse, un message d'erreur ou un log.
- **Pas de redirection** vers une URL arbitraire ; pas d'endpoint « proxy générique ».
- Homy n'envoie que des identifiants `{ agent, container }` **préalablement stockés dans son
  catalogue**, jamais une URL fournie par un client.
- **Aucun fetch d'URL arbitraire** côté Homy : base URL unique allowlistée + JWT côté Homy.

### 6.5 À éviter (anti-patterns)

- ❌ Un endpoint où le client **choisit l'hôte/URL** à interroger.
- ❌ Des **secrets en clair** dans une réponse, une URL ou un log (y compris le token Bearer).
- ❌ Des statuts `200` masquant un échec (conflit, introuvable, agent injoignable).
- ❌ Des réponses **lentes/synchrones longues** qui bloquent le proxy Homy.
- ❌ Des **champs instables** par appel (mêmes clés à chaque fois, valeurs typées).
- ❌ Exiger de Homy qu'il connaisse les **URL/clés de chaque agent**.

---

## 7. Points ouverts (tranchés par Docky — conservés pour mémoire)

> **Tous les points ci-dessous ont reçu une réponse de Docky le 2026-09-13** (voir l'encadré
> « Réponse de Docky » en tête de document) : préfixe dédié `/api/integration/v1`, clé
> d'intégration dédiée, vocabulaire normalisé, `cpu_percent` 0–100, clé stable = `name`,
> `409` idempotent, `disk_*` null, batches ≤100 cibles. Tableau conservé à titre de traçabilité.

| # | Question | Impact |
| --- | --- | --- |
| **Q1** | **Point d'entrée** : surface d'intégration côté **orchestrateur** (`/api/agents/...` agrégée) ou endpoints **par agent** (`/agent/...`) ? Base URL unique attendue par Homy. **Clé** : clé d'intégration **dédiée** ou réutilisation de `security.mcp_api_key` ? | Chemins, config Homy, sécurité |
| **Q2** | **Noms/valeurs exacts** : `state` vs `status` ; normalisation `health: null` → `"none"` ; gestion de `removing` et autres libellés ; identifiant container accepté (`name`, `id`, ou les deux) ? | Vocabulaire, parsing Homy |
| **Q3** | **Réponse des actions** : `200` synchrone avec `state`/`health` résultants, ou `202` asynchrone ? Renvoi de l'état post-action ? | Mise à jour immédiate des tuiles |
| **Q4** | **Granularité des stats** : snapshot ponctuel ou moyenne sur fenêtre ? `cpu_percent` normalisé hôte (0–100) ou multi-cœurs (0–N×100) ? `mem_usage` inclut-il le cache ? | Affichage monitoring |
| **Q5** | **Batch** : forme définitive de `POST /api/containers/health` ; plafond de cibles ; **batch stats** fourni ou non ? | Nombre d'appels, perf |
| **Q6** | **Disque / réseau** : `network_rx/tx` exposés en octets cumulés ? **Disque** (`disk_usage/limit/percent`) prévu ? À quelle échéance ? | Option monitoring (§D.5) |
| **Q7** | **Format d'erreur** : `{ error, code }` avec `code` machine stable ? Statut pour agent injoignable dans un batch (`200` + erreur par cible vs `502` global) ? | Robustesse, messages |
| **Q8** | **Versionnage & stabilité** : l'API d'intégration est-elle versionnée (ex. `/api/v1/...`) ? Garanties de compatibilité ascendante ? | Évolution future |
| **Q9** | **Identité des containers** : un `container` recréé change-t-il d'`id` ? Que recommandez-vous de stocker côté Homy (`name` stable ?) ? | Persistance de la cible |
| **Q10** | **Rate limiting** : Docky applique-t-il une limite d'appels ? Comportement attendu (`429`) et en-têtes de quota ? | Cadence 30 s multi-tuiles |

---

## 8. Côté Homy (rappel — pour information)

Cette section n'est **pas** à implémenter par Docky ; elle décrit le pendant Homy (lot 5 de la
roadmap) pour clarifier l'intégration de bout en bout.

### 8.1 Routes exposées par Homy

Toutes **protégées par JWT** et **sans jamais exposer de secret Docky** :

| Route Homy | Rôle |
| --- | --- |
| `GET /api/docky/status` | État de l'intégration : `{ configured, reachable, mode: "live" or "degraded" }`. |
| `GET /api/docky/agents` | Liste des agents (liste déroulante). |
| `GET /api/docky/agents/:agent/containers` | Containers d'un agent (liste déroulante). |
| `POST /api/docky/health` | Batch état + santé pour un lot de `{ agent, container }`. |
| `GET /api/docky/stats` | Stats d'un container (ou batch selon §4.6). |
| `POST /api/docky/actions` | Action `start` / `stop` / `restart` sur `{ agent, container }`. |

Toutes ces routes : base URL **allowlistée** (une seule), timeout borné, JWT requis, aucune clé
Docky renvoyée au front.

### 8.2 Mode dégradé

- Docky **absent / non configuré / injoignable** → pastille **grise**, monitoring **« — »**,
  **contrôles désactivés** (roadmap §D.4).
- **Container inconnu** → `state: "unknown"`, rendu neutre.
- Un **stub dégradé** est livrable (lot 5) avant même que Docky n'implémente ce contrat.

### 8.3 Cible Docky d'un élément

- Un élément du catalogue porte une cible **`docky: { agent, container }`** (déjà validée côté
  serveur Homy : `agent` ≤ 64 car., `container` ≤ 128 car., `null` autorisé).
- La cible est choisie via une **liste déroulante filtrable** alimentée par Docky (§4.1–4.2),
  avec **repli en saisie libre** si Docky est indisponible.
- L'action agit **par élément**, sur sa cible `{ agent, container }` (roadmap §A.6).

---

## Annexe A — Correspondance avec les endpoints Docky existants

| Besoin du contrat | Endpoint Docky existant (agent) | Endpoint orchestrateur existant | Écart principal |
| --- | --- | --- | --- |
| Lister les agents | — | `GET /api/agents` | Auth web (cookie), pas Bearer ; à agréger/exposer. |
| Agents (santé) | `GET /agent/health` | `ping_all()` interne | — |
| Lister les containers | `GET /agent/containers` | `GET /api/agents/{name}/containers` | `health: null` à normaliser (`none`). |
| État unitaire | `GET /agent/containers/{id}` | — | — |
| Stats | `GET /agent/containers/{id}/stats` | — | Pas d'endpoint orchestrateur dédié. |
| Actions | `POST /agent/containers/{id}/{start\|stop\|restart}` | — | Renvoie `200 {success:false}` en échec → demander `404/409/502/504`. |
| Auth | `Bearer DOCKY_AGENT_API_KEY` | — | Exposer un **Bearer unique** côté intégration. |

> Ces endpoints existants servent de **base d'alignement** ; le contrat ci-dessus décrit la
> surface **stable** attendue par Homy. Toute divergence doit être traitée en §7.

---

*Fin du document. Aucun secret n'est inclus : les valeurs sensibles sont représentées par des
placeholders (`<token>`, `DOCKY_API_KEY`).*
