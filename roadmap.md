# Homy — Roadmap

> **Statut :** document de conception. Les décisions ci-dessous sont **validées** ; la refonte
> du modèle « éléments » est **implémentée pour les lots 1→8** (le lot 5 est **FAIT le
> 2026-09-13**, après acceptation/implémentation du contrat par Docky — voir
> `docs/docky-integration-contract.md`, §D.3 et §I).
> **Dernière mise à jour :** 2026-09-13
> **Version courante :** `0.1.0` (source de vérité : `version.txt`)
> **Portée :** dépôt `/projects/Homy` uniquement. Le contrat d'API Docky est **spécifié ici**
> mais son implémentation est **hors périmètre** de Homy (§D).

---

## Conventions de lecture

- **Langue.** Ce document est rédigé en **français**. Les **identifiants techniques restent en
  anglais** (`widget`, `group`, `element`, `button`, `elements.json`, `settingsSchema`,
  `healthCheck`, `monitoring`, `controls`, …) pour coller au code et à l'UI (qui est en anglais).
- **État.** Chaque décision de conception est accumulée ici **avant** implémentation ; la
  roadmap est la source de vérité du chantier « éléments / groupes / catalogue / boutons ».
- **Rappel projet.** Zéro build (vanilla JS + ES modules), single-user, gridstack v13 vendoré,
  stockage JSON atomique. Voir `README.md` pour l'architecture technique existante.

## Sommaire

- §A — Refonte du modèle « éléments » (validée, non implémentée)
- §B — Grille interne des groupes
- §C — Legacy / nettoyage
- §D — Docky (monitoring / santé / contrôles)
- §E — Icônes
- §F — Reporting spécial (plugins)
- §G — API & sécurité (principes)
- §H — Contraintes à préserver
- §I — Plan en lots (statut, dépendances, vérifications)
- §J — Points ouverts
- §K — Déjà livré (contexte)

---

## A. Refonte du modèle « éléments » (validée, implémentée pour les lots 1→4)

### A.1 Les quatre notions

| Notion | Nature | Détails |
| --- | --- | --- |
| `widget` | Outil autonome existant | Les widgets actuels : `clock`, `search`, `weather`, `notes`, `iframe`, … Leur `settingsSchema` déclaratif est **conservé** tel quel (modal générique, parité serveur/front inchangée). |
| `group` | Cadre-conteneur | Remplace le `frame` historique. C'est un conteneur **qui peut contenir des widgets ET des éléments/boutons** (voir §B pour sa trame interne). |
| `element` | Entité du **catalogue GLOBAL** | Décrite dans `elements.json`, **référencée par `id`** partout ailleurs. Ce n'est pas un item de layout : c'est une fiche réutilisable. |
| `button` | Instance posée | Instance d'un `element` **posée dans un `group`** ; porte les **interrupteurs d'affichage** (icon, label, shortcut, health, monitoring, controls — §A.4). Plusieurs `button` peuvent référencer le même `element`. |

**Règle structurante :** un **groupe peut contenir des `widget` ET des `element`/`button`**.
Autrement dit un groupe n'est pas « réservé aux liens » : c'est un conteneur hétérogène.

### A.2 Catalogue global — `elements.json`

- Le catalogue vit dans un **fichier dédié `elements.json`**, **PAS** dans `layout.json`.
  Raison : `layout.json` est **réécrit en bloc à chaque drag** — y loger un référentiel
  coûterait des écritures inutiles et couplerait des données stables à des données volatiles.
- Champs d'un `element` :
  - `name` — libellé affichable ;
  - `icon` — icône (emoji / URL / `holaf:<name>` / `local:<slug>` — §E) ;
  - `url` — raccourci cible (lien) ;
  - `description` — texte libre ;
  - `healthCheck` — définition du contrôle de santé (délégué à Docky, §D) ;
  - **cible Docky** `{ agent, container }` — serveur (agent) + conteneur visés pour
    health / monitoring / controls ;
- L'`element` porte **l'identité et la cible**. C'est le `button` (instance) qui porte
  **l'apparence et les options d'affichage**.

### A.3 Composition d'un groupe

```
group (cases globales, mini 2×2)
 ├─ widget   (existant, settingsSchema conservé)      ── trame interne (§B)
 ├─ button   → element #42  (interrupteurs on/off)    ── trame interne (§B)
 ├─ button   → element #7
 └─ widget   (search, clock, …)
```

### A.4 `button` — options on/off

Un `button` est une instance d'un `element` posée dans un groupe. Ses **interrupteurs
d'affichage** (chaque option active/désactive une zone) :

| Interrupteur | Rôle |
| --- | --- |
| `icon` | Affiche l'icône de l'élément. |
| `label` | Affiche le libellé. |
| `shortcut` | **Zone cliquable** : ouvre l'`url` de l'élément. |
| `health` | **Pastille** de santé (état délégué à Docky, §D). |
| `monitoring` | **CPU / RAM** (stats déléguées à Docky, §D). |
| `controls` | **2ᵉ zone cliquable** : contrôles `start` / `stop` / `restart` (§A.6). |

### A.5 Matrice de variantes

**Un visuel distinct par combinaison** d'interrupteurs. Les variantes de référence à produire :

- icône seule ;
- icône + `label` ;
- icône + `health` (pastille) ;
- icône + `monitoring` ;
- icône + `controls` ;
- **tuile info monitoring seul** ;
- **tuile statut seul** (`health`) ;
- **contrôles seuls** ;
- **état « rien d'activé »** (aucune option : rendu de repli explicite, pas de tuile vide/cassée).

Chaque variante doit tenir dans les **tailles de tuile** suivantes, exprimées en **cases
globales** (soit, en trame interne §B : `2×2`, `4×2`, `2×4`, `4×4`) :

| Taille (cases globales) | Équivalent interne | Usage typique |
| --- | --- | --- |
| `1×1` | `2×2` | icône seule / pastille seule (tuile minimale légale) |
| `2×1` | `4×2` | icône + label sur une ligne |
| `1×2` | `2×4` | icône + label empilés |
| `2×2` | `4×4` | tuile info (monitoring) ou contrôle complète |

> La matrice **variante × taille** est la référence de recette visuelle : chaque case doit
> avoir un rendu dédié et cohérent (pas de débordement, pas de chevauchement).

### A.6 Contrôles (`controls`)

- Actions : **`start` / `stop` / `restart`**.
- Elles s'appliquent **par élément** (l'action agit sur la cible Docky `{ agent, container }`
  de l'élément référencé).
- **Confirmation en 2 temps** : le bouton doit d'abord être **« armé »** (~3 s), puis un
  **second clic** envoie la commande. Aucune modale bloquante par défaut. Le bouton se
  désarme automatiquement au bout de ~3 s (ou au blur / `Escape` / clic ailleurs) — même
  patron que la suppression de page à 2 temps déjà livrée (§K).

### A.7 Règles de taille minimale par variante (validées)

L'UI ne doit **jamais** permettre de descendre sous le minimum d'une variante : soit elle
contraint la taille, soit elle propose la taille qui convient. Les minima sont exprimés en
**cases globales** — rappel : une unité « 1×1 » de bouton = **2×2 cases internes** (la trame
interne d'un groupe est 2× plus fine que la grille globale, §B).

| Variante | Minimum (global) | Idéal (global) | Remarque |
| --- | --- | --- | --- |
| Icône seule | `1×1` | `1×1` | tuile minimale légale (≈ 45 px à 1440) |
| Icône + label | `2×1` | `2×1` | icône + libellé sur une ligne |
| Icône + pastille santé | `1×1` | `2×1` | pastille en coin dès `1×1` |
| Icône + monitoring CPU/RAM | `2×2` | `2×2` | |
| Icône + contrôles | `2×1` | `2×2` | |
| Tuile info (monitoring seul) | `2×1` | `2×2` | |
| Tuile statut (santé seule) | `2×1` | `2×1` | |
| Tuile contrôles seule | `2×1` | `2×2` | |
| Aucune option activée | `1×1` | `1×1` | rendu de repli explicite |

- **Unité de base confirmée** : `1×1` ≈ **45 px** sur un canvas de **1440 px** (case globale
  45 px, case interne 22,5 px, tuile minimale 45 × 45 px) — voir §B.1.
- **Exposition de la règle** : la fonction `minSizeForVariant(options)` (exposée par
  `public/js/elements/button.js`) renvoie `{ min, ideal }` en **cases internes**, prête à
  contraindre l'édition des tuiles (lot 4).
- **Passe de typographie compacte** attendue dans les tuiles : libellés et valeurs (CPU/RAM,
  contrôles, pastilles) doivent **tenir dans la tuile** à toutes les tailles légales — pas de
  débordement, et pas de glyphe d'icône qui se superpose à une tuile voisine (défaut visuel
  constaté au lot 2, à corriger).

---

## B. Grille interne des groupes

Hypothèse de référence : le groupe couvre l'écran.

| Repère | Grille globale | Grille interne d'un groupe |
| --- | --- | --- |
| Dimensions | **32 × 18** | **64 × 36** (2× plus fine) |
| Équivalence | — | **1 case interne = ½ case globale** |

### B.1 Tailles et conversions

- Le **plus petit élément** = **2×2 cases internes** = **1×1 case globale**.
- Sur un canvas de **1440 px** : case globale **45 px**, case interne **22,5 px**, tuile
  minimale **45 × 45 px** — **unité de base confirmée** (§A.7).
- Sur un canvas de **1920 px** : la même règle donne une case globale de **60 px** (tuile
  minimale 60 × 60 px, case interne 30 px).

### B.2 Placement & redimensionnement

- **Placement libre** des contenus **à la case interne** (donc au **demi-cran global**).
- Le **groupe** se redimensionne en **cases globales** (taille **mini 2×2 cases globales**).
- **Le contenu garde une taille physique constante** : il **ne suit pas** le redimensionnement
  du groupe (on rogne / on scrolle, on ne met pas à l'échelle).
- **Débordement** (groupe plus petit que son contenu) : **scroll interne** au groupe.
- Les **widgets posés dans un groupe** suivent la **même trame interne** que les boutons.

---

## C. Legacy / nettoyage

- `frame` → devenu **`group`** (renommage conceptuel + conteneurisation) — **fait**.
- `shortcut` et `links` → **supprimés** (lot 6) ; leur usage est **remplacé par les éléments +
  boutons** (§A). Les fichiers `public/js/widgets/{frame,shortcut,links}.js` et leurs entrées de
  manifest (serveur + front) ont été retirés ; la **liste finale** des widgets est donc
  `clock`, `iframe`, `search`, `notes`, `weather` **+ `group`**.
- **Normalisation** : comme la montée `search h:1 → h:2`, chaque **tuile de bouton** existante
  est **remontée au minimum de sa variante** (`minSizeForVariant`, §A.7) au chargement (éditeur
  **et** viewer), avec relocalisation au premier slot libre si la nouvelle empreinte déborde ou
  chevauche une voisine ; le résultat est persisté à la prochaine sauvegarde.
- **Aucune migration à porter** : l'utilisateur n'a **rien de configuré** (aucun layout
  legacy peuplé à traduire).
- **Tolérance obligatoire** : un **type inconnu** doit être **ignoré proprement** au chargement
  (item sauté, log/`muted`, jamais de crash ni de layout cassé). C'est la protection générale
  contre d'anciens fichiers ou de futurs types retirés.
- **Versionnage du schéma :** layout **v3 → v4**. Le catalogue `elements.json` est un fichier
  distinct et porte son **propre champ `version`** (indépendant de `layout.json`).

---

## D. Docky (monitoring / santé / contrôles)

### D.1 Délégation

- Le **monitoring par container** et le **health check** sont **délégués à Docky**.
- Modèle Docky : **un agent par serveur**, **monitoring par container**.
- Homy **n'accède pas à Docker** : il interroge Docky (voir contrat ci-dessous).

### D.2 Choix de la cible Docky

- La cible Docky d'un élément se choisit via une **liste déroulante filtrable** (recherche
  textuelle) **alimentée par Docky** (agents puis containers).
- **Repli en saisie libre** si Docky est indisponible (l'utilisateur peut renseigner
  `{ agent, container }` à la main).

### D.3 Contrat d'API (à transmettre à Docky)

> **Contrat de référence :** [`docs/docky-integration-contract.md`](docs/docky-integration-contract.md).
> Ce document est la **spécification à transmettre** à l'équipe/agent qui développe Docky
> (endpoints, payloads, auth Bearer, codes d'erreur, cas dégradés, points ouverts). En cas
> d'écart entre ce résumé et le contrat, **le contrat fait foi**.

L'API Docky **n'existe pas encore** : un **contrat est à transmettre** à l'équipe Docky.
Il couvre au minimum :

- **agents** — lister les agents (nom, URL/identifiant, état) ;
- **containers** — lister les conteneurs par agent (pour la liste déroulante) ;
- **health** — état de santé par conteneur (pastille `health`) ;
- **stats CPU/RAM** — métriques par conteneur (`monitoring`) ;
- **actions** `start` / `stop` / `restart` (contrôles) ;
- **erreurs** — format d'erreur homogène (codes, messages) ;
- **auth** — **Bearer** (jeton/clé côté Homy, jamais exposé au front).

> **Périmètre :** l'**implémentation côté Docky est HORS PÉRIMÈTRE de Homy**. Homy spécifie le
> contrat, consomme le proxy (§G) et peut livrer un **stub dégradé** en attendant (§I, lot 5).
> **État :** le **lot 5 est FAIT (2026-09-13)** — Docky a **accepté et implémenté le contrat v1.0**
> (lots A+B) et Homy est branché dessus (client `docky.service.js`, proxy `/api/docky/*`, tuiles
> santé/monitoring réelles, contrôles start/stop/restart, sélecteur de cible, mode dégradé). Voir
> l'encadré « Réponse de Docky » de
> [`docs/docky-integration-contract.md`](docs/docky-integration-contract.md).

### D.4 Cas dégradés

- **Docky absent / injoignable** → pastille **grise**, monitoring affiché **« — »**,
  **contrôles désactivés**.
- **Élément non auto-hébergé** (sans cible Docky) → **ni santé ni monitoring** : la tuile est
  un **simple lien** (`shortcut` vers son `url`).

### D.5 Monitoring affiché

- **CPU / RAM** (par défaut).
- **Disque & réseau en option**, à affiner plus tard (§J).

---

## E. Icônes

### E.1 Agrandissement des icônes

- Les icônes doivent pouvoir être **agrandies** : **option par bouton**.
- **5 crans S / M / L / XL / Fill** = **40 / 55 / 70 / 85 / 100 %** de la **dimension interne
  utile** de la tuile :
  - tuile **45 px** → **18 / 25 / 32 / 38 / 45 px** ;
  - tuile **90 px** → **36 / 50 / 63 / 77 / 90 px**.
- Option avancée **« autoriser le débordement »**, **désactivée par défaut** (l'icône reste
  contenue dans la tuile sauf si l'utilisateur l'autorise explicitement).
- S'applique à **toutes les sources d'icônes** (emoji, URL, `holaf:<name>`, `local:<slug>`).

### E.2 Recherche en ligne + installation locale

- Le **serveur Homy** (qui a accès à Internet) interroge un **service de recherche d'icônes**.
- Il **télécharge le SVG** puis le **stocke localement** dans un **store d'icônes côté serveur**.
- Référence future : **`local:<slug>`**, **à côté** des sources existantes **emoji**,
  **`holaf:<name>`** et **URL**.
- **Rendu par inlining** : le SVG est injecté dans le DOM — **pas d'URL publique** exposée —
  et **`currentColor` est conservé** (l'icône suit la couleur de texte du thème).

### E.3 Licence & traçabilité

- **Uniquement des collections PERMISSIVES** (MIT / Apache-2.0 / ISC / CC0…) : **filtrage par
  défaut**, les licences **non permissives sont masquées**.
- Pour chaque icône installée on **conserve `source` + `license` + `auteur`** (traçabilité et
  **attributions**). Ces métadonnées vivent dans l'index local du store d'icônes.

---

## F. Reporting spécial (plugins)

- Sur un **élément**, une case à cocher **« Special reporting »** permet de **choisir un
  service prédéfini** dans une liste : `jellyfin`, `radarr`, `sonarr`, `qbittorrent`, … —
  puis d'obtenir un **affichage dédié** (lectures en cours, stats serveur, file d'attente,
  torrents, …).
- C'est un **type d'élément dédié** (**tuile dédiée**, **taille libre**), **PAS** un
  interrupteur de `button` (ce n'est donc pas une des cases de la matrice §A.5).
- Architecture **pluggable** : un **registre de types de report** ; implémentation
  **service par service**, **Jellyfin d'abord**.
- **Implémenté (lot 8)** : `server/services/reports.service.js` (registre `reportTypes` : `jellyfin`
  implémenté ; `radarr` / `sonarr` / `qbittorrent` **déclarés non implémentés**), routes
  `/api/reports/{types,:elementId,test,:elementId/test}`, config `report` sur l'élément (clé API
  **masquée** côté front), tuile de report dédiée (taille libre) dans un `group`.
- Les **clés API des services restent côté serveur** et ne sont **jamais exposées au front**.

---

## G. API & sécurité (principes)

### G.1 Nouvelles routes

- **Catalogue** — `/api/elements` : **CRUD** + **usage** (savoir où un élément est référencé).
- **Proxy Docky** — `/api/docky/*` (agents, containers, health, stats, actions).
- **Proxy des reports** — relais serveur vers les services de reporting (§F).
- **Store d'icônes** — recherche + installation locale (§E).
- **Bornes & validation strictes** comme l'existant : **max items / layout**, corps
  **≤ 256 Ko**, validation de types et de bornes, etc.

### G.2 Sécurité

- **Identifiants / clés** (Docky, services de report, service d'icônes) **jamais renvoyés au
  front**.
- **Aucun fetch d'URL arbitraire** depuis le serveur.
- Les appels externes passent par une **base URL configurée / allowlistée**.
- **JWT requis** sur les routes protégées (cohérent avec l'existant).

---

## H. Contraintes à préserver

- **Zéro build** : vanilla JS / ES modules.
- **Single-user.**
- **gridstack v13 vendoré** (`public/vendor/gridstack/`).
- **Parité `settingsSchema` / `defaultSize`** serveur ↔ front, verrouillée par
  `scripts/check-schema-sync.mjs` (`npm run check:schema`).
- **Store JSON atomique + debounce** (écriture `.tmp` → `rename`, `.bak`).
- **Pages & layout v3 → v4** (le `layout.json` reste multi-pages).
- **Briques holaf-lib** vendorées (`public/vendor/holaf/`, versions épinglées par manifest).
- **Animation du bandeau** et **fond clippé** déjà livrés : ne pas régresser.

---

## I. Plan en lots (statut, dépendances, vérifications)

### I.1 Vue d'ensemble

| Lot | Contenu | Statut | Dépend de |
| --- | --- | --- | --- |
| **1** | Modèle & stockage serveur (`elements.service` / routes, **layout v4**, types/bornes/buttons, montage, `check-schema-sync`) | **FAIT** | — |
| **2** | Modèle front & registry (`catalog.js`, `button.js`, `group.js`, retrait `frame`/`shortcut`/`links`, groupe conteneur, tolérance type inconnu) | **FAIT** | **1** |
| **3** | Écran catalogue (UI CRUD + form) | **FAIT** | **2** |
| **4** | Groupe + boutons + options (trame interne, picker, panneau d'options, matrice de variantes) | **FAIT** | **2** (puis 3) |
| **5** | Proxy Docky + santé / monitoring / contrôles | **FAIT (2026-09-13)** — contrat v1.0 **accepté et implémenté par Docky** ([`docs/docky-integration-contract.md`](docs/docky-integration-contract.md)) ; client serveur + proxy `/api/docky/*` + cache + mapping d'erreurs + tuiles réelles + contrôles 2 temps + sélecteur de cible + mode dégradé | **4** |
| **6** | Nettoyage & polish (suppression des widgets legacy, palette, libellés, README) | **FAIT (2026-09-13)** | **3, 4** |
| **7** | Bibliothèque d'icônes (recherche, install locale, index + licences, picker) | **FAIT (2026-09-13)** | indépendant |
| **8** | Reporting spécial (registre de plugins, Jellyfin d'abord) | **FAIT (2026-09-13)** | indépendant |

### I.2 Ordre logique

```
1 ──▶ 2 ──▶ 3 ──▶ 4 ──▶ 6
              └──▶ 5  (FAIT — contrat Docky §D.3 accepté/implémenté)

7 (indépendant, FAIT)      8 (indépendant, FAIT)
```

- Cœur du chantier : **1 → 2 → 3 → 4**, puis **6**.
- **5** est **FAIT (2026-09-13)** : le contrat Docky ([`docs/docky-integration-contract.md`](docs/docky-integration-contract.md))
  a été **accepté et implémenté côté Docky** ; Homy consomme la surface versionnée
  `/api/integration/v1` via un proxy JWT allowlisté, avec un mode dégradé complet.
- **7** et **8** sont **indépendants** et peuvent être menés en parallèle.

### I.3 Vérifications attendues par lot

**Transverses (à chaque lot) :**

- **Parité schémas** : `npm run check:schema` passe (settingsSchema + defaultSize) après tout
  ajout/retrait de widget ou d'option.
- **Bornes** : max items/layout, corps ≤ 256 Ko, bornes de tailles respectées.
- **Non-régression** : drag & drop, pages/onglets, **animation du bandeau**, **fond clippé**.
- **Sécurité** : aucun secret renvoyé au front ; proxy à base URL allowlistée ; JWT requis.

**Par lot :**

- **Lot 1** — `layout v4` lu/écrit sans perte ; `elements.json` CRUD borné ; tolérance aux
  types inconnus côté serveur ; `check-schema-sync` vert.
- **Lot 2** — registre front reconstruit (retrait `frame`/`shortcut`/`links`) ; **un type
  inconnu est ignoré proprement** (pas de crash de layout) ; groupe conteneur hétérogène
  (widgets **et** boutons).
- **Lot 3** — création/édition/suppression d'éléments ; validation des champs ; « usage »
  cohérent (élément supprimé → boutons orphelins gérés).
- **Lot 4** — trame interne (demi-cran) exacte ; groupe mini 2×2 globales ; contenu à taille
  physique constante ; **scroll interne** au débordement ; recette de la **matrice de
  variantes** (§A.5) ; contrôles en **2 temps**.
- **Lot 5** — **(fait)** proxy `/api/docky/*` **allowlisté** et JWT ; client `docky.service.js`
  (Bearer côté serveur uniquement, timeouts bornés, cache TTL ~30 s, découpage batch ≤100 et
  ré-indexation, `409` idempotent, mapping d'erreurs) ; cas dégradés §D.4 couverts ; tuiles
  santé/monitoring réelles ; contrôles en **2 temps** ; sélecteur de cible filtrable (repli
  saisie libre) ; **aucune** clé Docky au front ni dans les logs.
- **Lot 6** — **(fait)** plus de widget legacy actif (retirés des DEUX côtés : manifest serveur +
  registre front) ; palette et libellés à jour (`clock`/`iframe`/`search`/`notes`/`weather`/
  `group`) ; tolérance conservée (item legacy/inconnu ignoré au chargement, `POST` type inconnu
  → 400) ; tuiles de groupe normalisées au minimum de leur variante ; README cohérent.
- **Lot 7** — **(fait)** source par défaut : **API Iconify** publique (`ICONS_API_BASE`
  configurable/allowlistée ; icons0.dev n'expose pas d'API HTTP documentée) ; **filtrage permissif
  seul** (MIT / Apache-2.0 / ISC / CC0-1.0 / BSD-2/3-Clause / Unlicense) au search **et** à
  l'install (400 sinon) ; `source`/`license`/`author` conservés dans `icons.json` et **affichés**
  dans l'onglet Installed ; rendu par **inlining** (`currentColor`), référence `local:<slug>`
  résolue via `GET /api/icons/:slug/svg` (JWT) ; SVG validé (≤ 64 Ko, pas de `<script>`/`on*=`/
  `<foreignObject>`, pas de référence externe).
- **Lot 8** — registre de types de report ; **Jellyfin** fonctionnel (sessions actives normalisées +
  infos serveur, états dégradés `unreachable`/`timeout`/`unauthorized`) ; clés API services
  strictement côté serveur (masquage `hasApiKey` dans TOUTES les réponses catalogue) ; tuile de
  report dédiée (taille libre sur la trame interne) avec rafraîchissement 30 s et cleanup au
  dispose ; formulaire « Special reporting » + test de connexion ; `radarr`/`sonarr`/`qbittorrent`
  restent **déclarés non implémentés**.

---

## J. Points ouverts

- **Curseur px vs crans d'icône** — **défaut retenu : crans** S/M/L/XL/Fill (§E.1) ; le mode
  curseur en px reste une alternative à trancher.
- **Autres types de reports** — **Jellyfin implémenté (lot 8)** ; `radarr`, `sonarr` et
  `qbittorrent` sont **déclarés dans le registre mais non implémentés** (le reste de la liste à
  prioriser).
- **Disque / réseau dans le monitoring** — **optionnels**, à affiner plus tard (§D.5).
- **Confirmation modale vs 2 temps** — **défaut retenu : 2 temps** (§A.6).

---

## K. Déjà livré (contexte, pour situer)

- **Pages multiples + onglets** (`layout` v3, `ui/tabs.js`, rename inline, « + », suppression
  à 2 temps).
- **Bandeau compact caché par défaut** avec **bascule clic droit** + **chorégraphie animée**.
- **Dézoom adaptatif du cadre d'édition**.
- **Fond clippé au cadre** (sans pop).
- **Placement vertical libre** (`float`).
- **Correctifs de sécurité / robustesse**.
- **Migration legacy 12 → 32** colonnes.
- **Modèle « éléments »** (lots 1→4) : catalogue global (`/api/elements`, `elementsModal.js`),
  layout **v4** avec `group` + `buttons[]`, widget conteneur `group` (trame interne, matrice de
  variantes, état degré dégradé), picker d'éléments + panneau d'options des tuiles.
- **Nettoyage lot 6** : widgets legacy `frame`/`shortcut`/`links` supprimés (serveur + front),
  normalisation des tuiles de groupe au minimum de leur variante, README/roadmap à jour.
- **Bibliothèque d'icônes (lot 7)** : recherche en ligne via l'API Iconify (base configurable),
  installation locale (SVG validé + index `icons.json` avec licence/auteur), filtre permissif
  (search + install), référence `local:<slug>` résolue et **inlinée** (`currentColor`), sélecteur
  front (`ui/iconsPicker.js`) branché sur le formulaire d'élément.
- **Reporting spécial (lot 8)** : registre de providers (`reports.service.js`) — **Jellyfin**
  implémenté (`/Sessions` + `/System/Info` normalisés, états dégradés), `radarr`/`sonarr`/
  `qbittorrent` déclarés ; routes `/api/reports/*` (JWT) ; config `report` sur l'élément avec
  **clé API masquée** (`hasApiKey`, sentinelle `__KEEP__` au PATCH) ; section « Special reporting »
  du formulaire d'élément (test de connexion) ; **tuile de report dédiée** dans un `group`
  (taille libre, état vide explicite, rafraîchissement 30 s nettoyé au `disposeWidget`).

---

*Fin du document. Les décisions §A→§K sont validées ; seule l'implémentation (§I) reste à
mener, dans l'ordre indiqué. Aucun commit n'est fait depuis ce chantier — l'utilisateur gère
git.*
