<p align="center">
  <img src="docs/banner.webp" alt="QwenProxy" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.es.md">Español</a> ·
  <b>Français</b>
</p>

Passerelle API hautes performances compatible OpenAI, Anthropic et Gemini qui relie les agents et clients de codage IA modernes (Claude Code CLI, OpenAI Codex, OpenCode, Cursor, OMP, Zed, Grok) à **Qwen (`chat.qwen.ai`)** avec rotation multi-comptes, bascule intelligente, appel d'outils robuste, exécution delta native par fil, génération d'images et de vidéos, **API Responses complète d'OpenAI avec mémoire persistante** et sessions durables. Propulsé par Chromium headless furtif, échelles de retry transitoires, variantes publiques base/`-fast`/`-thinking`, cache compressé, registre dynamique des capacités des modèles et observabilité complète.

---

> **Avis de fork / Fork notice**
>
> Ce dépôt est un fork personnel de **[johngbl/qwenproxy](https://github.com/johngbl/qwenproxy)**, lui-même dérivé de **[pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy)**, créé à l'origine par **Pedro Farias**.
>
> - Projet original : [pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy) - Licence ISC
> - Fork amont : [johngbl/qwenproxy](https://github.com/johngbl/qwenproxy) - Licence ISC
> - Ce fork : [jul-ienfr/qwenproxy](https://github.com/jul-ienfr/qwenproxy)
>
> Tout le crédit de l'architecture d'origine, du travail protocolaire et du code revient à **Pedro Farias** et **johngbl**. Ce fork n'ajoute que des changements locaux de packaging, de configuration et de déploiement ; il ne revendique pas la paternité du code amont.
>
> This repository is a personal fork of **[johngbl/qwenproxy](https://github.com/johngbl/qwenproxy)**, itself derived from **[pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy)**, originally created by **Pedro Farias**.

---

[![CI](https://github.com/jul-ienfr/qwenproxy/actions/workflows/ci.yml/badge.svg)](https://github.com/jul-ienfr/qwenproxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/qwenproxy-cli.svg)](https://www.npmjs.com/package/qwenproxy-cli)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.13-green)](https://hono.dev/)
[![Patchright](https://img.shields.io/badge/Patchright-Stealth-blueviolet)](https://github.com/kaliiiiiiiiii/patchright)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/johngbl)
[![Ko-fi](https://img.shields.io/badge/Donate-Ko--fi-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/johngbl)

## ❤️ Soutenir le projet

Si **QwenProxy** vous aide, vous ou votre équipe, et que vous souhaitez soutenir la maintenance continue, les nouvelles intégrations clients, les tests en direct et les correctifs rapides en amont, envisagez un parrainage volontaire :

<a href="https://github.com/sponsors/johngbl" target="_blank"><img src="https://img.shields.io/badge/Sponsor%20on%20GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="GitHub Sponsors"></a> <a href="https://ko-fi.com/johngbl" target="_blank"><img src="https://img.shields.io/badge/Donate%20via%20Ko--fi-ff5e5b?style=for-the-badge&logo=kofi&logoColor=white" alt="Ko-fi"></a>

Chaque contribution aide à couvrir les coûts d'infrastructure, la bande passante du proxy et les comptes de test !

> **Note pour ce fork :** ces liens de don soutiennent le mainteneur amont, **johngbl**. Ce fork ne collecte aucun don.

---

## 🚀 Fonctionnalités clés

- **Compatibilité native OpenAI, Anthropic et Gemini** — `/v1/chat/completions`, `/v1/models`, `/v1/messages` (**API Anthropic Messages native** pour **Claude Code CLI** et le SDK officiel `@anthropic-ai/sdk`), `/v1/messages/count_tokens`, **API OpenAI Responses** (`/v1/responses`), **Gemini `generateContent` / `streamGenerateContent`** (`/v1beta/models/{model}:...`) et `/v1/completions` (adaptateur hérité).
- **Contrat OpenAPI 3.1 et documentation interactive** — un contrat lisible par machine sur `/openapi.json`, la source canonique dans `docs/openapi.yaml` et un explorateur interactif sans dépendance sur `/docs` (clé API conservée en mémoire uniquement).
- **Matrice complète de 4 modes de conversation** — `thread` (persistant par défaut), `thread-temp` (delta éphémère ~1 Ko, recommandé pour les agents de codage), `stateless-temp` (standard officiel sans état d'OpenAI, éphémère) et `stateless` (standard officiel sans état d'OpenAI, enregistré dans le compte web).
- **Bascule dynamique des modes en temps réel** — Changez instantanément le mode API global via la TUI (`M` sur l'écran de statut ou `F4` dans le Chat) ou via l'endpoint HTTP `/v1/chat/mode`, sans redémarrer le serveur.
- **Tableau de bord terminal complet TUI (`qpx`)** — Interface monospace interactive avec prise en charge complète de la souris (survol, clic, glisser et défilement), sélecteurs verticaux de modèle/mode et titre de fenêtre terminal natif `QwenProxy`.
- **Import de comptes par lots (`B`)** — Collez des dizaines de comptes en quelques secondes (format `email:motdepasse`, `.env`, tabulation, pipe). Stockés avec chiffrement au repos dans une seule transaction SQLite (<10 ms) avec déduplication et compteurs en direct.
- **Défilement dynamique de la vue** — Navigation fluide dans des listes de 50+ comptes sans débordement de mise en page ni désalignement de colonnes.
- **Synchronisation des agents de codage en 1 clic (`qpx sync`)** — Configuration automatisée pour Claude Code, OpenAI Codex, OpenCode, Cline, OMP, Zed, Kilo Code et Hermes avec restauration de sauvegarde en 1 clic.
- **Instance Chromium unique ultra-légère** — 1 processus navigateur partagé avec accélération WebGL matérielle et états de stockage `BrowserContext` isolés (~200 Mo de RAM pour tous les comptes, >65 % de réduction des ressources).
- **Préchauffage à la demande et pool multi-comptes** — Démarrage instantané avec le **compte principal prêt** ; les comptes en veille restent inactifs et se préchauffent paresseusement à la demande (pendant une bascule ou une rotation).
- **Synchronisation propre de la personnalisation** — Les invites système et les outils passent par la personnalisation du compte (`/settings/personalization`), en miroir du client web officiel, évitant les déclencheurs de bot du WAF.
- **Externalisation des grands contextes** — Lorsque l'historique complet de l'agent dépasse `QWEN_EXTERNALIZE_CONTEXT_BYTES` (90 Ko par défaut) et que la requête contient des outils, l'historique est téléversé comme pièce jointe texte Qwen et seul le dernier tour reste en ligne. Cela évite le seuil de déclenchement WAF/captcha d'environ 128 Kio de Qwen sur les longues boucles agentiques. Un cache de préfixe (`QWEN_EXTERNALIZE_CACHE_*`) réutilise la pièce jointe précédente entre les tours et ne réinjecte que le delta, évitant un nouvel envoi de 100–300 Ko à chaque tour d'agent.
- **Recherche web opt-in avec citations** — Activez la recherche web Qwen par requête (`web_search`, `web_search_options`, l'en-tête `X-QwenProxy-Web-Search` ou un suffixe de modèle `-search`). Les sources retournées sont exposées en `annotations` de style OpenAI (`url_citation`) plus une extension `search_results`, avec `X-QwenProxy-Web-Search` et les métadonnées `search` indiquant si la recherche a réellement été exécutée.
- **Parseur d'appels d'outils auto-réparant** — Gère les flux fragmentés, les paramètres JSON cassés, les balises unifiées `<qpx_call>`, la correspondance floue des noms (`readFile` → `read_file`) et les échelles de retry automatique intelligentes.
- **Génération d'images et de vidéos** — Endpoints dédiés `/v1/images/generations`, `/v1/images/edits` et `/v1/videos/generations` avec des modèles phares (`qwen-image-3.0-pro`, `wan3.0-video`, `wan2.7-image-pro`). L'édition d'image accepte les téléversements multipart `image` + `prompt` (PNG/JPEG/WebP/GIF) et le même pipeline compte/quota/captcha que la génération.
- **Observabilité et surveillance de l'état** — Métriques en temps réel sur `/health`, `/metrics` (Prometheus), watchdog RSS et paires de logs propres et unifiées par tour.

---

## 🏛️ Architecture

```mermaid
flowchart TD
    Client["Client : Claude Code / Codex / OpenCode / Cursor / OMP"] -->|HTTP / SSE| Proxy["QwenProxy - Hono"]
    Proxy --> Chat["/v1/chat/completions"]
    Proxy --> Anthropic["/v1/messages"]
    Proxy --> Gemini["/v1beta/models/{model}:generateContent"]
    Proxy --> Completions["/v1/completions (hérité)"]
    Proxy --> Responses["/v1/responses"]
    Proxy --> Media["/v1/images | /v1/videos"]
    Proxy --> Models["/v1/models"]
    Proxy --> Upload["/v1/upload"]
    Anthropic --> Chat
    Gemini --> Chat
    Completions --> Chat
    Responses --> Chat
    Responses --> Effort["Normalisation de l'effort"]
    Responses --> State[("SQLite responses_store")]
    Chat --> Context["Contexte natif par fil"]
    Chat --> Accounts["Gestionnaire de comptes"]
    Accounts --> DB[("SQLite chiffré")]
    Accounts --> Playwright["Playwright + Stealth"]
    Playwright --> Fingerprint["Empreinte / session keeper"]
    Chat --> Parser["Parseur d'appels d'outils"]
    Chat --> Personalization["Réglages + synchronisation de personnalisation"]
    Chat --> BrowserTransport["Fetch de page Playwright + pont SSE"]
    BrowserTransport --> Qwen["chat.qwen.ai"]
    Media --> BrowserTransport
    Upload --> OSS["Qwen OSS"]
```

---

## 🔄 Modes de conversation

QwenProxy propose une matrice complète de **4 modes de conversation**, vous permettant de choisir l'équilibre exact entre efficacité des tokens, latence et organisation de l'historique :

| Mode | Stratégie de charge utile | Mode Qwen amont | Enregistré dans le compte web ? | Cas d'usage recommandé |
| :--- | :--- | :--- | :---: | :--- |
| **`thread-temp`** ⭐ | **Delta (~1 Ko)** | `chat_mode: "local"` | ❌ Non (zéro pollution) | **Le meilleur mode pour le développement quotidien.** Recommandé pour Claude Code, Codex, OpenCode et Cursor. Vitesse maximale, TTFB ultra-bas et aucune encombrement de la barre latérale sur `chat.qwen.ai`. |
| **`stateless-temp`** | **Historique complet** | `chat_mode: "local"` | ❌ Non (zéro pollution) | **Standard officiel des API (OpenAI/Anthropic).** Renvoie l'historique complet des messages à chaque tour. Idéal si votre client modifie, élague ou réordonne les tours passés en cours de session. |
| **`thread`** *(défaut)* | **Delta (~1 Ko)** | `chat_mode: "normal"` | ✅ Oui (enregistré sur le web) | Parfait si vous souhaitez inspecter ou poursuivre plus tard la conversation de votre agent directement dans l'application mobile officielle `chat.qwen.ai` ou le navigateur de bureau. |
| **`stateless`** | **Historique complet** | `chat_mode: "normal"` | ✅ Oui (enregistré sur le web) | Renvoie l'historique complet des messages à chaque tour tout en conservant chaque session de chat dans l'historique de votre compte Qwen. |

### Comment changer de mode :

1. **Via la TUI interactive (bascule globale en temps réel) :**
   - **Sur l'écran `[1] Status` :** appuyez sur **`M`** (ou cliquez sur `[ M ] Alternar Modo`) pour faire défiler instantanément le mode API global.
   - **Sur l'écran `[2] Chat` :** appuyez sur **`F4`** (ou cliquez sur le bouton d'en-tête `[ Modo ]`) pour ouvrir le sélecteur modal vertical.
2. **Via l'endpoint HTTP distant :**
   ```bash
   # Inspecter le mode actif :
   curl http://127.0.0.1:7936/v1/chat/mode

   # Mettre à jour le mode global en temps réel :
   curl -X POST http://127.0.0.1:7936/v1/chat/mode \
     -H "Content-Type: application/json" \
     -d '{"mode":"thread-temp"}'
   ```
3. **Remplacement par en-tête au niveau de la requête :**
   Envoyez `X-QwenProxy-Chat-Mode: thread-temp` (ou `stateless-temp`, `thread`, `stateless`) dans chaque requête HTTP.
4. **Via la configuration `.env` (valeur par défaut au démarrage) :**
   ```env
   QWEN_CHAT_MODE=thread
   ```

---

## 📖 Pas à pas : prise en main

### 1. Installation

Installez la CLI QwenProxy globalement sur votre poste de travail :

```bash
# Via npm :
npm install -g qwenproxy-cli

# Ou via pnpm / bun :
pnpm add -g qwenproxy-cli
# bun add -g qwenproxy-cli
```

Vous pouvez aussi télécharger un binaire autonome depuis la page des releases GitHub (Windows x64, Linux x64/arm64). Node.js n'est pas requis :

```bash
sha256sum -c SHA256SUMS
./qwenproxy-linux-x64 --version
```

Les binaires autonomes n'embarquent pas Chromium : installez Node.js et exécutez `npx patchright install chromium`, ou utilisez l'image Docker. Consultez [docs/STANDALONE.md](docs/STANDALONE.md) pour les chemins portables de données/`.env`, la vérification des sommes de contrôle et le modèle de confiance des binaires non signés.

### 2. Lancer le tableau de bord interactif (TUI)

Ouvrez votre terminal et exécutez :

```bash
qpx
```

QwenProxy lance le serveur proxy hautes performances en arrière-plan et ouvre le tableau de bord interactif. Le titre de la fenêtre du terminal devient automatiquement **`QwenProxy`**.

### 3. Ajouter des comptes Qwen

> 🌐 **Où créer des comptes ?**
> Créez vos comptes gratuits directement sur le portail web officiel Qwen : **[https://chat.qwen.ai](https://chat.qwen.ai)**
> 1. Rendez-vous sur **[chat.qwen.ai](https://chat.qwen.ai)** et cliquez sur **Sign up**.
> 2. Inscrivez-vous avec votre e-mail et mot de passe (ou via Google).
> 3. *Astuce :* créez 3 à 10 comptes pour que QwenProxy puisse basculer automatiquement entre eux lorsque les quotas quotidiens sont atteints, vous offrant un codage continu et ininterrompu !

Dans la TUI, accédez à l'onglet **`[5] Accounts`** pour gérer les identifiants :

- **Import par lots (`B`) :** appuyez sur **`B`** (ou cliquez sur `[ B ] Em Lote`). Collez vos identifiants de comptes en masse (`email:motdepasse` par ligne, chaîne `.env` brute avec des virgules, ou collage depuis un tableur). Le parseur calcule les comptes valides en temps réel, gère sans risque les caractères spéciaux des mots de passe, ignore les doublons et enregistre les identifiants chiffrés dans SQLite en une seule transaction (<10 ms).
- **Compte unique (`A`) :** appuyez sur **`A`** pour saisir manuellement l'e-mail et le mot de passe.
- **Connexion navigateur :** si vous préférez une connexion visuelle avec résolution manuelle du captcha : `qpx login`.

### 4. Synchroniser les agents de codage IA

Pour configurer automatiquement vos agents de codage installés afin qu'ils passent par QwenProxy :

```bash
# Synchroniser automatiquement tous les agents détectés :
qpx sync

# Ou cibler des agents spécifiques :
qpx sync claude codex opencode
```

Le synchroniseur configure :
- **Claude Code CLI** (`~/.claude/settings.json`) — Protocole Anthropic natif (`/v1/messages`).
- **OpenAI Codex CLI** (`~/.codex/config.toml`) — Protocole Responses natif (`/v1/responses`).
- **OpenCode** (`~/.config/opencode/opencode.jsonc`) — Fournisseur compatible OpenAI.
- **Cline, OMP, Zed, Kilo Code et Hermes Agent**.
> **Astuce restauration :** restaurez à tout moment les sauvegardes de configuration précédentes avec `qpx sync --restore` (ou `npm run sync:restore`).
### 5. Lancez-vous !

Démarrez votre outil de codage préféré comme d'habitude :
```bash
# Lancer Claude Code :
claude

# Lancer Codex CLI :
codex

# Lancer OpenCode :
opencode
```
Toutes les complétions et tous les appels d'outils passeront par votre passerelle QwenProxy locale, sans frais d'API externes, avec de grandes fenêtres de contexte et une rotation multi-comptes automatique !

---

## 🌐 Proxy sortant par compte

Chaque compte Qwen peut utiliser son propre proxy sortant HTTP/HTTPS/SOCKS5. L'ordre de résolution est **proxy du compte → `PROXY_URL` → direct**.

```bash
npm run proxy list
npm run proxy set account-a@example.com http://user:pass@proxy-a.example.com:8080
npm run proxy set account-b@example.com socks5://proxy-b.example.com:1080
npm run proxy clear account-a@example.com
npm run proxy test account-a@example.com
```

Les identifiants de proxy sont chiffrés au repos et masqués dans la TUI, la CLI et les logs. Changer un proxy ne ferme que le contexte navigateur de ce compte ; la requête suivante le relance via le nouvel egress. Un proxy injoignable marque le compte avec la raison de cooldown `ProxyUnavailable` et la bascule normale s'applique.

Pour Docker/CI, la variable d'environnement optionnelle `QWEN_ACCOUNT_PROXIES` accepte des paires `email=proxy` séparées par des virgules ou des points-virgules.

---

## 🔑 Clés API multi-utilisateurs et quotas

QwenProxy peut émettre des clés API par consommateur avec des limites RPM et de flux simultanés indépendantes. Les clés sont stockées sous forme de hachages SHA-256 dans SQLite ; la clé en clair n'est affichée qu'une seule fois, à la création ou à la rotation.

```bash
# Créer un utilisateur (illimité par défaut)
npm run users create alice

# Limite : 60 requêtes/minute, max 2 flux simultanés
npm run users create alice --rpm 60 --concurrency 2

# Inspecter, faire tourner, révoquer
npm run users list
npm run users limits alice 120 4
npm run users rotate alice
npm run users revoke alice
```

Utilisez la clé exactement comme l'ancienne clé API globale :

```bash
curl http://127.0.0.1:7936/v1/chat/completions \
  -H "Authorization: Bearer sk-qpx-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"hello"}]}'
```

**Comportement des quotas**

- `--rpm` utilise une fenêtre glissante de 60 secondes ; `0` signifie illimité.
- `--concurrency` limite les flux actifs par clé ; `0` signifie illimité.
- Le dépassement de l'une ou l'autre limite renvoie HTTP `429` avec `Retry-After` **avant** tout travail sur un compte Qwen ou le navigateur.
- Les emplacements de flux sont libérés à la fin, en cas d'erreur ou d'annulation par le client.
- Une clé `sk-qpx-...` révoquée ou remplacée est rejetée avec `401`.

**Rôles et compatibilité ascendante**

- L'ancienne `API_KEY` reste un administrateur global et contourne les quotas.
- Sans `API_KEY` configurée sur une écoute loopback, les requêtes locales restent non authentifiées et agissent comme un administrateur local (comportement historique).
- Une clé utilisateur valide résout toujours vers cet utilisateur, même en loopback.
- Les clés révoquées ne retombent jamais sur la confiance d'administrateur local.
- Les clés de rôle `admin` peuvent gérer les utilisateurs via l'API admin ; les clés de rôle `user` reçoivent `403` sur les routes de gestion.

**API admin** (mêmes en-têtes d'authentification, rôle admin requis) :

| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/admin/api/users` | GET | Lister les utilisateurs, les limites et les flux actifs |
| `/admin/api/users` | POST | Créer un utilisateur et renvoyer sa clé une seule fois |
| `/admin/api/users/:id` | PATCH | Mettre à jour `rpm` / `concurrency` |
| `/admin/api/users/:id/rotate` | POST | Faire tourner et renvoyer la nouvelle clé une seule fois |
| `/admin/api/users/:id` | DELETE | Révoquer (la ligne est conservée pour l'audit) |

Pour l'amorçage Docker/CI, `USER_API_KEYS` accepte des entrées `key:label[:rpm[:concurrency]]` séparées par des virgules. `USER_RATE_LIMIT_RPM` et `USER_MAX_CONCURRENCY` définissent les valeurs par défaut des utilisateurs créés via la CLI/API.

### 🖥️ Tableau de bord d'administration web

Le proxy sert également un tableau de bord authentifié depuis le même processus sur `http://<host>:<port>/admin` (pas de second serveur, pas de build frontend) :

- **Connexion** avec l'ancienne `API_KEY` ou une clé `sk-qpx-...` de rôle admin. Sur une installation loopback sans clé, le champ peut rester vide (confiance historique d'administrateur local). Le navigateur reçoit un cookie de session signé `HttpOnly; SameSite=Strict` valide 8 heures ; le jeton CSRF reste en mémoire.
- **Vue d'ensemble** : comptes prêts/actifs/en cooldown, flux actifs, RPM, taux d'erreur, latence moyenne, mémoire, tokens quotidiens et disponibilité. En direct via SSE avec repli automatique sur un polling de 5 secondes.
- **Comptes** : ajouter/supprimer, effacer un ou tous les cooldowns, rafraîchir les en-têtes et modifier les proxies par compte. Les e-mails et identifiants de proxy sont masqués dans chaque réponse.
- **Utilisateurs** : créer, modifier RPM/concurrency, faire tourner et révoquer les clés (les clés sont affichées une seule fois).
- **Modèles** : catalogue en direct avec fenêtre de contexte et capacités.
- **Réglages** : valeurs modifiables à chaud et autorisées, persistées dans `.env` (`chat_mode`, `global_proxy_url`, `chat_request_log`, `rate_limit_requests`, `rate_limit_tokens`, `user_default_rpm`, `user_default_concurrency`), plus un éditeur **Model mappings** pour les alias `MODEL_MAP` à l'exécution.
- **Logs / Audit** : logs récents avec rédaction des secrets et enregistrement durable de chaque mutation du tableau de bord/de l'API.

Les mutations authentifiées par cookie exigent `x-csrf-token` ; les clients bearer en sont exemptés. Le secret de signature de session est stocké dans `data/db/.admin_session_secret` (mode `0600`), afin que les sessions survivent aux redémarrages. La TUI reste disponible et voit le même état. Utilisez TLS ou un tunnel de confiance avant d'exposer le tableau de bord au-delà du loopback ; l'interface affiche un avertissement lorsqu'elle est servie en HTTP simple sur une adresse non-loopback.

### Accès depuis une autre machine (LAN)

1. Dans `.env`, écoutez sur toutes les interfaces et définissez une clé forte. Une écoute non-loopback est refusée au démarrage lorsque `API_KEY` est vide ou encore la valeur d'exemple :

   ```bash
   HOST=0.0.0.0
   API_KEY=<long-random-key>
   ```

   Les clients envoient ensuite `Authorization: Bearer <long-random-key>` (ou utilisent une clé utilisateur `sk-qpx-...` de la spec 002) pour `/v1` et `/admin`.

2. Autorisez le TCP entrant 3000 sur les réseaux privés. Sous Windows, exécutez une fois dans PowerShell en administrateur :

   ```powershell
   New-NetFirewallRule -DisplayName "QwenProxy 3000" -Direction Inbound `
     -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private,Domain
   ```

3. Ouvrez `http://<lan-ip>:3000/admin` depuis l'autre machine et connectez-vous avec `API_KEY`. Le tableau de bord affiche l'avertissement TLS car le transport est en HTTP simple ; c'est attendu sur un LAN de confiance.

4. Ne gardez qu'un seul processus proxy lié au port. Sous Windows, une écoute `127.0.0.1` et une écoute `0.0.0.0` peuvent coexister, ce qui répartit silencieusement le trafic local et LAN entre deux instances. Vérifiez avec `netstat -ano | findstr :3000` et arrêtez toute instance obsolète avant de démarrer celle du LAN.

Consultez [`specs/003-web-admin-dashboard/quickstart.md`](specs/003-web-admin-dashboard/quickstart.md) pour des exemples d'API et le dépannage.

### Icône de barre d'état et webview de bureau (optionnel)

Sous Windows, `qpx gui` (ou `qpx --gui`) démarre le proxy si nécessaire et ouvre le tableau de bord dans une fenêtre WebView2 native. Une icône de barre d'état à côté de l'horloge rouvre la fenêtre après sa fermeture ; **Quit** dans le menu de la barre d'état arrête le serveur enfant.

Le GUI exige Node.js 24+ et le paquet optionnel `@webviewjs/webview`. Il réutilise un serveur déjà en cours d'exécution, conserve le profil du webview dans `<data>/gui-webview` (l'auto-login recrée le cookie de session à chaque démarrage), mappe `HOST=0.0.0.0` vers `127.0.0.1` pour sa propre fenêtre et se connecte automatiquement en loopback avec `API_KEY` (surchargeable via `QWEN_GUI_ADMIN_KEY`). L'auto-login est limité au loopback et ne modifie ni l'authentification du tableau de bord ni l'accès LAN. Les binaires serveur autonomes et Docker restent sans GUI.

Consultez [`docs/GUI.md`](docs/GUI.md) pour l'installation et le dépannage.

---

## 💡 Conseils de production et bonnes pratiques

1. **Utilisez `thread-temp` pour le codage agentique :**
   Les agents de codage génèrent des dizaines de tours et d'appels d'outils par minute. Le mode `thread-temp` garde votre compte Qwen propre tout en offrant un TTFB fulgurant de ~0,6 s à 1,2 s.
2. **Réinitialisation des quotas multi-comptes (00:00 UTC) :**
   Configurez 2 comptes ou plus. Les quotas quotidiens de Qwen Web se réinitialisent strictement à **00:00 UTC**. Lorsqu'un compte atteint sa limite, le proxy le met en pause jusqu'à minuit et promeut sans interruption le prochain compte de secours sain.
3. **Élagage des profils disque (`qpx clean`) :**
   Au fil du temps, les contextes Chromium accumulent des caches V8 et GPU transitoires. Exécutez `qpx clean` pour réduire les profils de ~300 Mo à **~4,5 Mo par compte**, en préservant intacts les cookies et les sessions authentifiées.
4. **Réinitialisation instantanée des cooldowns :**
   Pour débloquer immédiatement des comptes en cooldown, appuyez sur **`Z`** sur l'écran `[1] Status` ou exécutez `qpx reset`.

---

## 📦 Modèles et capacités

Les modèles et fenêtres de contexte sont synchronisés dynamiquement depuis le catalogue `/api/models` en direct de Qwen, par compte. Les capacités et métadonnées sont résolues automatiquement :

| Modèle | Fenêtre de contexte | Sortie max | Réflexion | Vision |
| :--- | :---: | :---: | :---: | :---: |
| `qwen3.8-max` | 1 000 000 | 131 072 | ✅ Oui | ✅ Oui |
| `qwen3.7-plus` | 1 000 000 | 65 536 | ✅ Oui | ✅ Oui |
| `qwen3.7-max` | 1 000 000 | 65 536 | ✅ Oui | ❌ Non |
| **Fallback** | **1 048 576** | **65 536** | — | — |

### Mapping de modèles à l'exécution

Gardez fonctionnels les noms de modèles codés en dur dans les clients lorsque Qwen fait tourner son catalogue. Définissez `MODEL_MAP` (une graine utilisée jusqu'à ce que le fichier géré par l'admin existe) ou modifiez le mapping depuis la carte **Settings → Model mappings** du tableau de bord :

```dotenv
MODEL_MAP=gpt-4o=qwen3.8-max,claude-sonnet=qwen3.8-max,*=qwen3.7-plus
```

- Les alias exacts sont insensibles à la casse et priment sur les alias de famille intégrés.
- `*=qwen-id` est un repli générique optionnel pour les noms de modèles inconnus.
- Les identifiants natifs Qwen (`qwen*`, `wan*`, `z-image*`) passent toujours inchangés.
- Les changements sont rechargés à chaud depuis `data/model-mappings.json` ; aucun redémarrage nécessaire.
- `/v1/models` liste les alias avec la fenêtre de contexte et les capacités de la cible.
- Les mappings invalides (cible vide, alias en double, chaîne d'alias, suffixe réservé `-search`/`-fast`/`-thinking`, clé d'alias Qwen) sont rejetés.

L'API admin est `GET|PUT|DELETE /admin/api/model-mappings` ; `PUT` accepte `{"map":"alias=qwen-id,*=fallback"}` ou `{"mappings":{"alias":"qwen-id"},"fallback":"qwen-id"}`.

### Variantes synthétiques

- Modèle de base — **Mode auto** (Qwen décide s'il faut raisonner), ex. : `qwen3.8-max`
- `-fast` — Réflexion désactivée pour une génération rapide, ex. : `qwen3.8-max-fast`
- `-thinking` — Réflexion forcée, ex. : `qwen3.8-max-thinking`
- `-search` — Recherche web activée pour cette requête, ex. : `qwen3.8-max-search`. Combinez avec un suffixe de raisonnement dans n'importe quel ordre (`qwen3.8-max-search-thinking`, `qwen3.8-max-high-search`).

### Recherche web et citations

La recherche web est **opt-in par requête** ; les requêtes qui ne la demandent pas conservent `auto_search: false`. Activez-la avec l'un des éléments suivants :

- corps `"web_search": true` (ou `"webSearch": true`) ;
- corps `"web_search_options": { ... }` (sa présence active la recherche) ;
- en-tête `X-QwenProxy-Web-Search: 1` (ou `true`/`on`/`yes`) ;
- un suffixe de modèle `-search`.

Tous les chemins d'activation utilisent le type de chat `search` de Qwen (`auto_search: true` plus `chat_type`/`sub_chat_type: "search"`) ; `auto_search` seul avec `t2t` a été vérifié en direct comme répondant sans rechercher. Un `false` explicite dans le corps ou l'en-tête prime sur toute source d'activation.
Les sources retournées en amont sont normalisées, dédupliquées et validées par URL (http/https uniquement, sans identifiants, sans hôtes locaux/privés). Elles apparaissent comme `annotations` OpenAI (`type: "url_citation"`), comme le tableau documenté `search_results` et dans les métadonnées de la réponse finale :

```json
{ "search": { "requested": true, "ran": true, "source_count": 3 } }
```

`X-QwenProxy-Web-Search` indique `not_requested`, `requested` (en streaming, avant que le résultat soit connu), `ran` ou `no_results`. `/v1/models` expose `supports_search` par modèle ; les variantes synthétiques `-search` ne sont pas listées séparément.

### Modes spécialisés (Deep Research, Web Dev, Full-Stack, Slides)

Quatre identifiants de modèles virtuels routent une requête de complétion
normale vers les pipelines spécialisés de Qwen. Ils sont toujours annoncés par
`/v1/models` avec `specialized_mode`, `supports_async`, `supports_citations` et
`supports_artifacts` :

| Modèle | Pipeline Qwen | Tâches asynchrones | Citations | Artefacts |
| :--- | :--- | :---: | :---: | :---: |
| `qwen-deep-research` | Deep Research (`normal` ou `advance`) | ✅ | ✅ | ✅ |
| `qwen-web-dev` | Web Dev | ✅ | ❌ | ✅ |
| `qwen-full-stack` | Web Dev avec contrat de prompt full-stack | ✅ | ❌ | ✅ |
| `qwen-slides` | Slides | ✅ | ❌ | ✅ |

Les alias `deep-research`, `web-dev`, `full-stack` et `slides` sont acceptés,
mais seuls les identifiants canoniques sont listés. L'utilisation synchrone est
identique à celle de n'importe quel autre modèle :

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $QWENPROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-deep-research","messages":[{"role":"user","content":"Résume le paysage de la sûreté IA en 2026"}]}'
```

Pour Deep Research, `research_mode: "advance"` (ou une requête `-thinking` / un
`reasoning_effort` élevé) sélectionne le pipeline coûteux ; `normal` est la
valeur par défaut. L'en-tête `X-QwenProxy-Research-Mode` est aussi accepté.

Les tâches longues doivent utiliser la surface asynchrone pour survivre à une
déconnexion :

```bash
# Démarrer une tâche
curl -X POST http://localhost:3000/v1/tasks \
  -H "Authorization: Bearer $QWENPROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-deep-research","messages":[{"role":"user","content":"Rapport sur le stockage sur réseau"}]}'
# → 202 {"id":"task_…","status":"queued","progress":0,…}

# Suivre, lister, annuler
curl http://localhost:3000/v1/tasks/task_…
curl "http://localhost:3000/v1/tasks?limit=20"
curl -X DELETE http://localhost:3000/v1/tasks/task_…
```

Une tâche est un appel au même pipeline de complétions avec `stream:false` ;
l'en-tête `Authorization` de l'appelant est transmis afin que les quotas, les
cooldowns et la sélection de compte s'appliquent toujours. Le statut vaut
`queued`, `running`, `succeeded`, `failed` ou `cancelled`.
`result.citations[]` liste les URL sources validées, `result.artifacts[]`
contient des entrées `{type, url, title?}` classées `report`, `pdf`, `image`,
`code` ou `link`, et `result.content` conserve la réponse complète.

Notes opérationnelles :

- Les tâches vivent dans SQLite local (`specialized_tasks`) avec une rétention
  de **7 jours**. Un redémarrage marque les tâches `queued`/`running` comme
  `failed` avec `code: "interrupted"`.
- L'état des tâches n'est **pas** partagé via Redis : `DATA_SAVE_MODE=redis`
  conserve les tâches locales à chaque instance.
- Les artefacts ne sont jamais récupérés, ré-hébergés ni exécutés. Les URL
  signées en amont conservent l'expiration de Qwen ; téléchargez-les avant ce
  TTL.
- Un mode indisponible renvoie **400** avec `code: "capability_unavailable"`
  (aucun compte configuré) ou `capability_unsupported` (pipeline refusé en
  amont), jamais une erreur 500 générique.

### Paramètre `reasoning_effort`

Les valeurs standard `reasoning_effort` d'OpenAI (`low`, `medium`, `high`) sont prises en charge :
- `low` / `none` → force le mode Fast (réflexion désactivée).
- `medium` / `high` / `max` → active la réflexion.

---

## 🌐 Endpoints pris en charge

### Compatible OpenAI
| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/v1/chat/completions` | POST | Complétions de chat (streaming et non-streaming) |
| `/v1/chat/completions/stop` | POST | Interrompre une génération active |
| `/v1/chat/mode` | GET / POST | Inspecter ou mettre à jour le mode de conversation global en temps réel |
| `/v1/models` | GET | Lister les modèles disponibles et leurs capacités |
| `/v1/models/:id` | GET | Détails d'un modèle |
| `/v1/responses` | POST | API OpenAI Responses complète avec mémoire persistante |
| `/v1/responses/:id` | GET / DELETE | Récupérer ou supprimer le contexte de réponse stocké |
| `/v1/completions` | POST | Adaptateur de complétions hérité |

### Compatible Anthropic
| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/v1/messages` | POST | API Anthropic Messages native (Claude Code CLI, SDK) |
| `/v1/messages/count_tokens` | POST | Endpoint de comptage de tokens |

### Compatible Gemini
| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/v1beta/models/{model}:generateContent` | POST | Gemini `generateContent` (texte, multimodal, appel de fonctions) |
| `/v1beta/models/{model}:streamGenerateContent` | POST | Variante de streaming SSE Gemini |
| `/v1beta/models` | GET | Catalogue de modèles au format Gemini |
| `/v1beta/models/{model}` | GET | Détails d'un modèle au format Gemini |

Les routes Gemini acceptent `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` ou `?key=` et signalent les champs de traduction non pris en charge via `X-QwenProxy-Gemini-Warnings`. Les familles de modèles Gemini sont aliasées vers les niveaux Qwen (`gemini-*pro*` → `qwen3.8-max`, `gemini-*flash*` → `qwen3.7-plus`), tandis que les identifiants Qwen directs passent inchangés.

### Génération de médias (images et vidéos)
| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/v1/images/generations` | POST | Génération d'images (`qwen-image-3.0-pro`, `wan2.7-image-pro`) |
| `/v1/images/edits` | POST | Édition d'image via multipart `image` + `prompt` (`qwen-image-3.0-pro` par défaut) |
| `/v1/videos/generations` | POST | Génération de vidéos (`wan3.0-video` jusqu'à 1080P, `wan2.7-t2v`) |
| `/v1/tasks/status/:taskId` | GET | Suivre la progression d'une tâche vidéo asynchrone |

### Tâches spécialisées (Deep Research, Web Dev, Full-Stack, Slides)
| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/v1/tasks` | POST | Démarrer une tâche en mode spécialisé asynchrone |
| `/v1/tasks` | GET | Lister les tâches de l'appelant (plus récentes d'abord) |
| `/v1/tasks/:taskId` | GET | Suivre le statut, la progression et le résultat |
| `/v1/tasks/:taskId` | DELETE | Annuler une tâche en attente ou en cours |

### Diagnostics et surveillance
| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/health` | GET | Vérification de l'état du système et métriques des flux actifs |
| `/metrics` | GET | Exposition Prometheus |
| `/v1/upload` | POST | Téléversement d'actifs multimodaux |

### Contrat d'API et documentation interactive
| Endpoint | Méthode | Description |
| :--- | :---: | :--- |
| `/openapi.json` | GET | Contrat OpenAPI 3.1 couvrant toutes les routes publiques |
| `/docs` | GET | Explorateur d'API interactif autonome (sans CDN, clé en mémoire uniquement) |

Le contrat canonique et vérifiable est [`docs/openapi.yaml`](docs/openapi.yaml) ; `/openapi.json` sert le document analysé et `/docs` le rend hors ligne.

---

## 🛠️ Commandes CLI et scripts NPM

| Commande | Description |
| :--- | :--- |
| `qpx` *(ou `npm run tui`)* | Ouvrir le tableau de bord TUI interactif avec serveur intégré |
| `qpx start` *(ou `npm start`)* | Démarrer le serveur proxy headless (sans interface) |
| `qpx gui` *(ou `qpx --gui`)* | Ouvrir l'icône de barre d'état et la webview du tableau de bord (optionnel, Node 24+) |
| `qpx sync` *(ou `npm run sync`)* | Configurer automatiquement les agents de codage (Claude Code, Codex, OpenCode, Cline, OMP) |
| `qpx clean` | Élaguer les caches transitoires des profils Chromium (~4,5 Mo par compte) |
| `qpx clean:all` | Récupérer l'espace disque des téléchargements de navigateur obsolètes (~4 Go) |
| `qpx reset` | Réinitialiser les cooldowns de débit et d'erreur dans la base |
| `npm run users list` | Lister les utilisateurs de clés API, rôles et quotas |
| `npm run users create <label> [--rpm N] [--concurrency N] [--admin]` | Créer un utilisateur et afficher sa clé une seule fois |
| `npm run users limits <id\|label> <rpm> <concurrency>` | Mettre à jour les quotas par utilisateur |
| `npm run users rotate <id\|label>` | Faire tourner une clé utilisateur et afficher la nouvelle une seule fois |
| `npm run users revoke <id\|label>` | Révoquer une clé utilisateur |
| `npm run redis:migrate` | Amorcer Redis depuis l'instantané SQLite local (mode multi-instance optionnel) |
| `qpx login` | Authentifier de nouveaux comptes via un navigateur visible |
| `qpx purge` | Supprimer l'historique de chat distant sur les comptes configurés |
| `qpx update` | Mettre automatiquement à jour QwenProxy vers la dernière version |
| `npm test` | Exécuter la suite de tests complète (suites mock et live) |
| `npm run typecheck` | Vérification TypeScript stricte (0 erreur exigée) |

---

## 🐳 Déploiement Docker

L'image est publiée pour `linux/amd64` et `linux/arm64` et inclut Chromium. Persistez `/app/data` pour que la base, la clé de chiffrement et les profils navigateur survivent aux mises à niveau. Les images sont taguées `latest`, par SHA de commit et par version de paquet.

```yaml
services:
  qwenproxy:
    build: .
    container_name: qwenproxy
    ports:
      - "${PORT:-7936}:7936"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    shm_size: "2gb"
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### Persistance partagée et mise à l'échelle multi-instance (optionnel)

SQLite reste la valeur par défaut et ne nécessite aucun Redis. Activez
`DATA_SAVE_MODE=redis` uniquement lorsque plusieurs instances doivent voir les
mêmes comptes, utilisateurs, sessions logiques, cooldowns, statistiques
quotidiennes et réponses Responses stockées.

```bash
DATA_SAVE_MODE=redis \
REDIS_URL=redis://127.0.0.1:6379 \
ENCRYPTION_KEY="<même valeur sur chaque instance>" \
npm start
```

- **Partagé :** comptes (chiffrés), cooldowns, utilisateurs/métadonnées de clés
  API, sessions logiques et parents, statistiques quotidiennes, réponses
  stockées.
- **Local à chaque instance :** profils Chromium, cookies d'authentification
  Qwen capturés, cache de personnalisation, journaux et piste d'audit admin.
- **Propagation :** les mutations sont répliquées dans Redis et annoncées sur le
  flux `qpx:events` ; les autres instances les appliquent sous
  `REDIS_SYNC_INTERVAL_MS` (1 s par défaut). La session est aussi préchargée
  directement avant un tour, ce qui permet une continuation immédiate sur un
  autre nœud.
- **Identifiants :** seules les lignes chiffrées AES-256-GCM sont partagées.
  Chaque nœud doit utiliser la même `ENCRYPTION_KEY` (ou le même fichier
  `.encryption_key`).
- **Panne Redis :** le trafic continue sur SQLite local et `/health` renvoie
  `persistence.connected=false` / `degraded=true`. `REDIS_REQUIRED=true` fait
  échouer le démarrage à la place.
- **Migration :** amorcez un Redis vide depuis un déploiement existant avec
  `DATA_SAVE_MODE=redis REDIS_URL=redis://... npm run redis:migrate`. La base
  SQLite source n'est jamais modifiée.
- **Exemple :** [`docker-compose.redis.yml`](docker-compose.redis.yml) lance
  Redis et deux instances sur les ports 7936/7937. Placez un répartiteur de
  charge devant pour une vraie montée en charge horizontale.

---

## ⚖️ Avertissement

**Ce logiciel est fourni « en l'état », sans garantie d'aucune sorte, expresse ou implicite.**

- **Aucune affiliation :** QwenProxy est un projet open source indépendant et n'est ni affilié, ni approuvé, ni sponsorisé par Alibaba, Qwen, OpenAI, Anthropic ou tout fournisseur mentionné.
- **Usage éducatif et personnel :** destiné à la recherche technique et au développement local. Les utilisateurs sont seuls responsables du respect des conditions d'utilisation amont, de la gestion de leurs propres identifiants et de la conformité aux lois applicables.
- **Responsabilité de l'utilisateur :** l'utilisateur assume l'entière responsabilité des limites de débit des comptes, des défis de sécurité et du contenu généré.

Développé et maintenu par **johngbl**, construit sur des fondations open source initialement écrites par **Pedro Farias** sous [licence ISC](LICENSE).

Ce dépôt est le fork **jul-ienfr**. Amont : [johngbl/qwenproxy](https://github.com/johngbl/qwenproxy). Original : [pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy).
