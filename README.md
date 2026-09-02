# Tibi Companion

Application PC (Windows + macOS) qui synchronise automatiquement ton dashboard
TibiSuite : elle surveille le fichier `Stats.lua` (SavedVariables du module
**Stats**), en extrait le code d'export à chaque `/reload` ou déconnexion en
jeu, et l'affiche dans un dashboard local (mêmes filtres, graphiques et
comparaison que [Dashboard.html sur Tibiscui.fr](https://tibiscui.fr/Dashboard.html)).

Rien n'est envoyé à un serveur : tout est lu et affiché en local, comme sur le
site.

## Statut

v0.1 — premier scaffold, **non testé dans une fenêtre réelle** (le
téléchargement du binaire Electron a été bloqué dans l'environnement où ce
code a été généré ; voir "Vérification effectuée" ci-dessous). À valider par
Tibiscui : `npm install` puis `npm start` sur une machine avec accès réseau
normal, puis un vrai `/reload` en jeu.

## Développement

```bash
npm install
npm start
```

## Build des installeurs

```bash
npm run dist:win   # NSIS (.exe)
npm run dist:mac   # DMG (macOS, doit tourner sur macOS ou via CI macOS)
```

`build/icon.png` (logo TibiSuite, 1024x1024, copié depuis
`Tibiscui.fr/medias/Logo_Site.png`) sert de source : `electron-builder` en
dérive automatiquement le `.ico` (Windows) et le `.icns` (macOS) au moment du
build. Si jamais la conversion échoue sur ta machine (droits réseau pour ses
outils internes, etc.), génère les fichiers à la main (ex. `png2icons`, ou un
convertisseur en ligne) et référence-les explicitement dans le champ `build`
de `package.json` (`win.icon`, `mac.icon`).

Dans l'app elle-même (fenêtre, tray), le même `src/assets/icon.png` est chargé
et redimensionné nativement par Electron (`nativeImage.resize`) : pas de
fichier séparé à maintenir pour ça.

### Note : build Windows et winCodeSign

Le build NSIS télécharge `winCodeSign` (paquet electron-builder, contient
entre autres des outils macOS) pour éditer les ressources de l'exe (icône
embarquée, métadonnées de version) même sans certificat de signature
configuré. Son extraction contient 2 liens symboliques macOS ; sur un compte
Windows standard sans le **Mode développeur** activé, 7-Zip échoue à les
recréer ("Cannot create symbolic link : le client ne dispose pas d'un
privilège nécessaire") et le build NSIS n'aboutit jamais.

**Solution : active le Mode développeur Windows** (Paramètres >
Confidentialité et sécurité > Pour les développeurs) avant de lancer
`npm run dist:win`. Une fois actif, `npm run dist:win` fonctionne sans
config particulière. (Une alternative existe sans toucher ce réglage :
mettre temporairement `win.signAndEditExecutable: false` et
`nsis.packElevateHelper: false` dans `package.json` — mais l'exe généré perd
alors son icône et ses métadonnées de version embarquées, cosmétique
uniquement, la fenêtre de l'app garde le bon logo dans tous les cas via
`nativeImage`.)

### Signature de code (Authenticode) — nécessaire avant distribution publique

Sans certificat de signature, Windows SmartScreen/Defender traite **tout**
`.exe` inconnu avec suspicion ("l'ordinateur a été protégé", éditeur non
reconnu) — ce n'est pas un bug de l'app, c'est le comportement par défaut de
Windows pour n'importe quel exécutable non signé. `win.signtoolOptions` est
déjà renseigné dans `package.json` (`publisherName: "Tibiscui"`, serveur
d'horodatage) : dès qu'un certificat est disponible au moment du build,
`npm run dist:win` signera automatiquement sans autre changement.

**Piège à connaître** : depuis juin 2023, les autorités de certification
(règle du CA/Browser Forum) n'émettent plus de certificats de signature de
code exportables en simple fichier `.pfx`. Un certificat neuf doit vivre sur
un token USB matériel ou un HSM cloud. Trois chemins, du plus simple au plus
classique :

1. **[SignPath.io](https://signpath.io/)** — signature **gratuite pour les
   projets open source** qualifiants (revue par leur équipe). Si TibiSuite /
   Tibi-Companion est ou devient public sur GitHub, c'est probablement
   l'option la moins chère et la plus adaptée à un projet solo. Leur CI
   s'intègre via une action GitHub ou une CLI ; regarder leur doc pour
   brancher `electron-builder` dessus (généralement : build non signé, puis
   étape de signature externe sur l'artefact `.exe`).

2. **Azure Trusted Signing** — service cloud de Microsoft (~10-15$/mois),
   pas de token matériel, déjà supporté nativement par `electron-builder`.
   Une fois le compte et le "Certificate Profile" créés côté Azure, ajoute
   dans `package.json` (`build.win`) :
   ```json
   "azureSignOptions": {
     "endpoint": "https://<region>.codesigning.azure.net",
     "certificateProfileName": "<nom-du-profil>",
     "codeSigningAccountName": "<nom-du-compte>"
   }
   ```
   et fournis l'authentification Entra ID via variables d'environnement au
   moment du build (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET` — jamais commitées, à passer en local ou en secret
   CI). Voir la doc officielle Azure Trusted Signing pour la création du
   compte/profil.

3. **Certificat classique (OV/EV) chez une autorité** (SSL.com, Sectigo,
   DigiCert...), ~100-400$/an, livré sur token USB ou HSM cloud selon
   l'autorité. Une fois le certificat accessible via `signtool` sur la
   machine de build (token branché, ou export via l'outil de l'autorité),
   `electron-builder` le détecte automatiquement via les variables
   `CSC_LINK` / `CSC_KEY_PASSWORD` (si l'autorité fournit un export utilisable)
   ou via `win.signtoolOptions.certificateSubjectName` /
   `certificateSha1` pour cibler un certificat déjà installé dans le magasin
   Windows. Un certificat **EV** donne une réputation SmartScreen immédiate ;
   un certificat **OV** reste flaggé quelque temps le temps de construire une
   réputation par le volume de téléchargements/exécutions.

**À ne jamais faire en attendant** : ni auto-signer avec un certificat local
pour tromper SmartScreen sur d'autres machines que la tienne (inutile, un
certificat auto-signé n'est reconnu nulle part ailleurs), ni désactiver
SmartScreen/Defender pour contourner l'avertissement — c'est une protection
légitime tant que l'app n'a pas de réputation ou de signature. Pour tester en
local en attendant un vrai certificat : clic droit sur l'installeur >
Propriétés > case "Débloquer" > OK, avant de l'exécuter.

## Architecture

- `src/main/` — processus principal Electron (Node) :
  - `wowScan.js` — détection des dossiers WoW / comptes / `Stats.lua`.
  - `watcher.js` — surveille un ou plusieurs `Stats.lua`, en extrait
    `StatsDB.export` (portage de la partie watch de
    `Tibiscui.fr/tools/companion/companion.mjs`, sans la publication
    git/SFTP/FTP : ici on affiche en local, on ne publie rien).
  - `store.js` — configuration locale (`userData/config.json`) : comptes
    suivis, démarrage automatique.
  - `main.js` — fenêtre, tray, IPC.
  - `preload.js` — pont `contextBridge` exposé au renderer (`window.companionAPI`).
- `src/renderer/` — interface (HTML/CSS/JS natif, pas de framework) :
  - `vendor/dashboard-shared.js` — **copie vendue** du moteur de rendu de
    Tibiscui.fr (décodeur LZW/djb2 + rendu BI). Voir l'avertissement en tête
    de ce fichier avant toute modification.
  - `vendor/site-style.css` — copie du `style.css` du site (palette, composants
    `.dash-*`).
  - `app.js` / `app.css` / `index.html` — chrome de l'app (onboarding, statut
    de synchro, bascule vers `TibiDashboard.mountGeneric`).

## Format d'export (à ne pas casser)

Comme documenté côté `Tibiscui.fr` et `TibiSuite - Unifié` : le format est un
**miroir sur 3 côtés** désormais (`Stats/Libs/LZW.lua` + `Stats/Export.lua` du
dépôt TibiSuite, `Tibiscui.fr/dashboard-shared.js`, et la copie vendue ici).
Toute évolution du format doit être reportée aux trois endroits.

## Vérification effectuée (sans fenêtre Electron réelle)

- `node --check` sur tous les fichiers du processus principal et du renderer.
- `wowScan.listAccounts` / `scanChosenFolder` testés contre une arborescence
  `_retail_/WTF/Account/<compte>/SavedVariables/Stats.lua` factice.
- `watcher.extractExport` testé sur un texte Lua factice (extraction correcte,
  `null` si absent).
- Pipeline complet **encodage de test → décodage via le fichier vendu
  `dashboard-shared.js` → `envelopeToProfiles`** rejoué dans Node (shim
  `window`/`atob`/`localStorage`) : schema, checksum (`djb2`) et
  personnages/jours décodés correctement.

Ce qui n'a **pas** pu être vérifié ici : l'ouverture réelle de la fenêtre
Electron, le tray, les dialogues natifs (`dialog.showOpenDialog`), et le rendu
DOM réel du dashboard dans Chromium. À faire au premier `npm start`.
