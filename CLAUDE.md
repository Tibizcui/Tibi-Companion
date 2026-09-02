# Tibi Companion — contexte pour Claude Code

Application PC (Electron, Windows + macOS) de Tibiscui : compagnon de
TibiSuite qui synchronise et affiche automatiquement le dashboard de
statistiques (module **Stats**) sans copier-coller de code. Destinée, à terme,
à être distribuée à tous les joueurs qui utilisent TibiSuite (pas seulement
Tibiscui) : deux installeurs séparés (NSIS Windows, DMG macOS).

> Convention d'écriture du projet : française, ton premium et honnête, jamais
> de tiret cadratin. Toujours signaler qu'un comportement n'a pas été vérifié
> dans une vraie fenêtre Electron / en jeu réel.

## Ce dépôt dans l'écosystème TibiSuite

Trois dépôts collaborent, ne pas confondre leurs rôles :

- **`TibiSuite - Unifié`** : les addons WoW (Lua). Le module **Stats** génère
  et auto-persiste le code d'export (`StatsDB.export`) à chaque `/reload`/
  déconnexion.
- **`Tibiscui.fr`** : le site vitrine statique. `dashboard-shared.js` décode
  et affiche ce code dans le navigateur (`Dashboard.html` = visualiseur
  générique, `Dashboard-Tibi.html` = page perso de Tibiscui). Son
  `tools/companion/companion.mjs` est un script **perso** (compte unique,
  publie vers le dépôt du site par git/SFTP/FTP) : ce n'est pas ce dépôt.
- **`Tibi-Companion`** (ici) : l'app publique. Elle lit le `Stats.lua` de
  n'importe quel joueur, décode en local, affiche en local. **Aucune
  publication, aucun réseau** : contrairement au companion.mjs perso, elle ne
  pousse rien nulle part.

## Format d'export (miroir sur 3 côtés, ne pas casser)

`Base64( LZW( JSON({schema, generatedAt, checksum, data}) ) )`, produit par
`Stats/Export.lua` + `Stats/Libs/LZW.lua` (dépôt TibiSuite - Unifié). Le
décodeur ici (`src/renderer/vendor/dashboard-shared.js`) est une **copie
vendue** du fichier du même nom dans `Tibiscui.fr`, lui-même miroir bit à bit
des fichiers Lua. Toute évolution du format doit être reportée aux **trois**
côtés (Lua, site, cette copie vendue), sinon les exports ne se lisent plus
quelque part. Le reste du fichier vendu (rendu, filtres, graphiques) peut
diverger librement entre le site et l'app si un besoin propre à l'app apparaît
: seule la partie décodage (LZW, djb2, `decodeExportCode`,
`envelopeToProfiles`) doit rester synchronisée.

Schémas : v1 = un code = un personnage, v2 = un code = tout le compte
(`data.chars["Nom-Royaume"]`). Les deux sont lus par le décodeur vendu.

## Architecture

- `src/main/` — processus principal (Node, CommonJS, pas de dépendance
  runtime pour l'instant : `fs`, `path`, `crypto` natifs seulement).
  - `wowScan.js` : détection des racines WoW par défaut selon l'OS, listing
    des comptes sous `<racine>/_retail_/WTF/Account/*/SavedVariables/Stats.lua`.
  - `watcher.js` : `AccountWatcher` (un `fs.watchFile` par compte, polling
    2s + debounce 1.5s, miroir de la logique de `companion.mjs`) et
    `WatcherPool` (plusieurs comptes WoW suivis en parallèle).
  - `store.js` : config JSON dans `app.getPath('userData')/config.json`
    (comptes suivis, démarrage auto). Jamais dans le dépôt.
  - `main.js` : fenêtre (ferme vers le tray, ne quitte pas l'app), tray icon,
    tous les handlers IPC (`companion:*`).
  - `preload.js` : `contextBridge` -> `window.companionAPI` (aucun accès Node
    direct côté renderer, `contextIsolation: true`, `sandbox: true`).
- `src/renderer/` — HTML/CSS/JS natif, pas de framework (cohérent avec
  `Tibiscui.fr`).
  - `vendor/` : fichiers copiés depuis `Tibiscui.fr`, voir avertissement en
    tête de chacun avant modification.
  - `app.js` : au démarrage, `companionAPI.getState()` puis onboarding (si
    aucun compte suivi) ou montage direct du dashboard. Sur
    `companionAPI.onExportUpdate`, injecte le blob dans le champ caché du
    formulaire `mountGeneric` et déclenche son bouton "submit" -> réutilise
    tel quel le pipeline de décodage/dédoublonnage/persistance
    (`localStorage`) déjà écrit et éprouvé côté site, plutôt que d'en
    réécrire un.

## Pièges connus / limites héritées

- WoW n'écrit `Stats.lua` qu'au `/reload` ou à la déconnexion : pas de
  temps réel possible, c'est une limite du jeu, pas de l'app.
- Le fichier surveillé est `Stats.lua` (module **Stats** déclare `StatsDB`),
  jamais `TibiSuite.lua` : même piège que documenté côté `TibiSuite - Unifié`
  et `Tibiscui.fr`.
- `contextIsolation`/`sandbox` sont actifs : ne jamais exposer `ipcRenderer`
  ou des modules Node directement dans `window` depuis `preload.js`, toujours
  passer par des fonctions dédiées dans `companionAPI`.

## Vérification

Pas de fenêtre Electron réelle disponible dans certains environnements (le
téléchargement du binaire Electron peut être bloqué). Dans ce cas, se limiter
à `node --check` sur tous les fichiers, et à des tests directs des modules
`src/main/*.js` via `node -e "require(...)"` (voir historique de session pour
des exemples : `wowScan` contre une arborescence factice, `watcher.extractExport`
contre un texte Lua factice, pipeline complet encodage/décodage contre
`vendor/dashboard-shared.js` avec un shim `window`/`atob`/`localStorage`). Dès
qu'un accès réseau normal est disponible : `npm install && npm start` reste la
vraie vérification, à faire avant toute release.
