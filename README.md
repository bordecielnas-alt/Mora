# Mora

Ton feed perso. L'IA cherche des contenus sur le web selon tes thèmes (articles, vidéos, shorts, podcasts, liens).
Tu fais défiler, tu gardes (♥) ou tu masques (« Pas pour moi »). Le feed apprend de tes choix, en silence.

## Avec Docker (Unraid, NAS, serveur)

Une image prête est publiée à chaque mise à jour : `ghcr.io/bordecielnas-alt/mora:latest` (amd64 et arm64).

```bash
docker run -d --name mora -p 3000:3000 -v /chemin/vers/mora-data:/data ghcr.io/bordecielnas-alt/mora:latest
```

Ou avec `docker compose up -d` (fichier `docker-compose.yml` à la racine). Ouvre ensuite `http://<IP-du-serveur>:3000`
et connecte ton compte Claude dans **Réglages** (voir plus bas).

- **Données** : tout ce qui doit survivre à une mise à jour est dans le volume `/data` : `users.json` (les comptes,
  mots de passe hachés) et un dossier par compte dans `users/` (son fil, ses gardés, sa connexion Claude). Sauvegarde ce dossier.
- **Utilisateur** : le conteneur écrit dans `/data` avec `PUID`/`PGID` (99/100 par défaut, comme Unraid).
- **Réglages** : les mêmes variables que dans `.env.example`, passées en variables d'environnement (`MORA_REFRESH_HOURS`, `MORA_BATCH`, `MORA_CLAUDE_MODEL`…).
- **Unraid** : un modèle prêt est dans [`unraid/mora.xml`](unraid/mora.xml).
- **Accès extérieur** : place Mora derrière ton reverse proxy en HTTPS (Nginx Proxy Manager, SWAG, Caddy…), un simple
  proxy HTTP vers le port 3000 suffit. Le HTTPS permet aussi d'installer Mora comme une app sur le téléphone.

## Comptes

Avec Docker (ou dès que Mora n'écoute plus seulement sur `127.0.0.1`), il faut se connecter. Chaque compte a **son propre
fil, ses gardés, ses réglages et connecte son propre compte Claude** : les recherches de chacun comptent dans son abonnement.

On se connecte avec son **adresse mail** et son mot de passe (aucun mail n'est envoyé : l'adresse sert d'identifiant).

1. **Premier lancement** : ouvre Mora et crée le compte administrateur avec le **code d'installation** affiché dans les logs
   (sur Unraid : icône du conteneur › Logs). Ou bien renseigne `MORA_ADMIN_USER` (ton adresse mail) et `MORA_ADMIN_PASSWORD`
   avant le premier lancement : le compte est alors créé tout seul (ces variables ne servent plus ensuite).
2. **Ajouter quelqu'un** : Réglages › Comptes › Ajouter un compte, avec son adresse mail et un mot de passe provisoire.
   La personne se connecte, change son mot de passe dans Réglages et connecte son compte Claude.
3. **Double authentification** (conseillée si Mora est accessible depuis Internet) : Réglages › Double authentification ›
   Activer, puis scanne le QR code avec une application d'authentification (Google Authenticator, Microsoft Authenticator,
   Aegis, 1Password…). Mora donne alors 10 **codes de secours**, à garder en lieu sûr : chacun permet une connexion sans le téléphone.
4. **Mot de passe oublié ou téléphone perdu** : un administrateur donne un nouveau mot de passe ou retire la double
   authentification (Réglages › Comptes).

Si tu utilisais déjà Mora avant les comptes, tes données et ta connexion Claude passent au compte administrateur.

Sécurité : mots de passe hachés (scrypt), double authentification TOTP (codes à usage unique, codes de secours hachés), sessions par cookie `HttpOnly` (et `Secure` derrière un proxy HTTPS),
déconnexion de tous les appareils au changement de mot de passe, blocage progressif après 5 essais ratés,
requêtes venant d'autres sites refusées. Il n'y a pas d'inscription libre : seul un administrateur crée des comptes.

## Lancer l'app sans Docker

Il faut **Node.js 20 ou plus récent** ([nodejs.org](https://nodejs.org)) et un **abonnement Claude** (Pro ou Max).

```bash
npm install
npm start
```

Sous Windows, tu peux aussi double-cliquer sur `Lancer-Mora.bat`.

Ouvre ensuite <http://localhost:3000>. `npm install` installe aussi Claude Code dans le dossier de l'app : rien d'autre à installer.

### Connecter ton compte Claude

Au premier lancement, le fil montre des contenus d'exemple et un bouton **Connecter mon compte Claude**
(aussi dans l'onglet **Réglages**) :

1. Clique sur **Ouvrir la page de connexion Claude** et connecte-toi avec ton compte.
2. Autorise l'accès. La page affiche un code.
3. Copie ce code, colle-le dans Mora et clique sur **Valider**.

La première recherche part tout de suite (une à trois minutes). Tu peux te déconnecter dans **Réglages**.

Pas de clé API, pas de facturation à l'usage : les recherches comptent dans les limites d'usage de ton abonnement.
Les recherches automatiques sont espacées d'au moins 30 minutes. Pour économiser ton quota :
`MORA_REFRESH_HOURS=12`, `MORA_BATCH=8` (valeurs par défaut : chaque compte peut les changer dans
Réglages › Recherche automatique, de « toutes les heures » à « jamais », et de 4 à 30 contenus par recherche) ou `MORA_CLAUDE_MODEL=sonnet` dans un fichier `.env` (modèle dans `.env.example`).

Ce qui coûte, c'est surtout la recherche web : chaque recherche ajoute environ 15 000 jetons de résultats à lire. Mora limite donc le nombre de recherches web par appel (Réglages › Profondeur de recherche : 6, 12 ou 25), n'ouvre pas les pages (il vérifie les liens lui-même), et remplace la longue consigne système de Claude Code par une consigne courte. La consommation réelle est visible dans l'onglet Stats.

En mode local, la connexion est celle de Claude Code : si tu utilises déjà Claude Code sur cet ordinateur, Mora partage la même connexion. Avec les comptes, chaque compte a sa propre connexion Claude.

## Comment ça marche

- **Pour toi** : le fil. Les propositions sont classées selon ce que tu as aimé, gardé ou masqué. Touche l'image (ou le titre)
  pour ouvrir le contenu dans un nouvel onglet, double-tape l'image pour l'aimer. « Pas pour moi » le retire du fil ; tu peux dire
  pourquoi (déjà vu, trop long, source bof, sujet hors cible, trop basique), et le feed n'ajuste alors que ce qui compte.
  **Déjà vu** : une carte compte comme vue quand elle sort par le haut de l'écran pendant que tu descends, après être restée
  au moins une seconde à moitié visible (un survol rapide ne compte pas) ; une vidéo lancée compte aussi. Elle ne disparaît
  pas sous ton doigt : elle quitte le fil au prochain chargement, sauf si tu l'as gardée. Ce que tu as aimé
  part aussi, et se retrouve dans **Gardés › Aimés** (où les vidéos se lisent aussi). L'onglet « Déjà vu »,
  à côté de « Nouveautés », retrouve tout ce que tu as vu ces 7 derniers jours.
  Les shorts s'affichent en format vertical. Les vidéos YouTube, Vimeo et TikTok se lisent directement dans l'app :
  elles se lancent toutes seules quand elles arrivent à l'écran et s'arrêtent quand elles en sortent (réglable dans
  Réglages › Apparence). Les navigateurs imposent le muet tant qu'on n'a pas touché la page : après le premier
  « Activer le son » (ou un toucher sur une vidéo), toutes les suivantes du fil démarrent avec le son, jusqu'à ce qu'on le
  coupe. Les boutons en haut à droite coupent le son, passent en plein écran ou ferment la vidéo.
  Le titre et la flèche ↗ ouvrent toujours la source d'origine. Derrière un proxy (Nginx Proxy Manager…), garde
  `Referrer-Policy: strict-origin-when-cross-origin` (le réglage de Mora) : YouTube refuse de lire si le referrer est supprimé.
  Le bouton de partage ouvre le menu de partage du téléphone (ou copie le lien sur l'ordinateur).
  Avant d'arriver dans le fil, chaque lien est vérifié : les pages mortes ou réservées aux abonnés sont écartées.
- **Recherche ponctuelle** (loupe en haut) : « trouve-moi les JO d'hiver cette semaine ». Les résultats arrivent dans un mini-fil à part, sans créer de thème.
  Quand la réserve baisse, ou toutes les 6 heures, l'app relance une recherche. Le bouton ↻ en lance une tout de suite (une à deux minutes).
- **Gardés** : ce que tu as gardé. Recherche par mot, filtres par centre d'intérêt et par format. « Exporter » télécharge tous tes gardés et tes notes en Markdown (Obsidian, Notion…). Touche un contenu pour ajouter une note, changer son thème, le mettre en favori ou le retirer.
- **Stats** : tes centres d'intérêt tels que le feed les a compris, une heatmap thème × format, ton activité sur 12 semaines et les formats appris. En bas, la **consommation de l'IA** : jetons utilisés aujourd'hui, sur 7 et 30 jours, une barre par jour, la moyenne par recherche et par contenu ajouté, et le détail des derniers appels (avec le coût équivalent au tarif de l'API, indicatif si tu passes par ton abonnement). L'administrateur voit aussi la consommation de chaque compte sur 30 jours dans Réglages › Comptes.
- **Réglages** :
  - ton compte Claude et tes thèmes, avec les thèmes que Mora te suggère d'après tes gardés ;
  - **Mes règles** : mots-clés interdits, sources bloquées, sources épinglées (suivies en priorité) ;
  - **Langue des contenus** : la langue d'origine à privilégier (pas des traductions), et un curseur pour le mélange avec l'anglais (par exemple 90 % français, 10 % anglais) ;
  - **Formats recherchés** : le poids des articles, vidéos, shorts (vidéos courtes verticales : YouTube Shorts, TikTok, Reels) et podcasts dans les recherches ;
  - **Sortir de ma bulle** : la part de contenus choisis hors de tes thèmes (marqués « Hors bulle ») ;
  - **Apparence** : clair, sombre ou automatique, la palette de couleurs, et la lecture auto des vidéos ;
  - **Masqués** : ce que tu as masqué ces 15 derniers jours, avec « Remettre » pour le replacer dans ton fil.

Les réglages de recherche comptent dès la recherche suivante.

L'apprentissage : chaque ♥ augmente le poids du thème, du format et de la source ; chaque « Pas pour moi » le baisse.
Ces poids servent à classer le fil et sont donnés à l'IA, avec tes derniers contenus gardés et masqués (et tes notes),
pour orienter la recherche suivante.

## Sur ton téléphone

Mets `HOST=0.0.0.0` dans `.env`, relance, puis ouvre `http://<IP-de-ton-ordinateur>:3000` sur le téléphone (même Wi-Fi).
Ça marche comme un site. Les comptes s'activent alors : un code d'installation s'affiche dans la console pour créer ton compte (voir « Comptes »). L'installation comme une vraie app sur le téléphone demande du HTTPS : voir la partie Docker (reverse proxy).
Sur l'ordinateur, Chrome ou Edge proposent déjà « Installer Mora » dans la barre d'adresse.

## Tes données

En mode local, tout est dans `data/mora.json` sur ta machine. Avec les comptes, chaque compte a son dossier `data/users/<id>/` (ou `/data/users/` avec Docker). Pour repartir de zéro, arrête l’app et supprime ce fichier (ou ce dossier).

## Organisation du code

```
server.js          serveur HTTP + API (aucune dépendance hors SDK Claude)
lib/store.js       stockage JSON
lib/learn.js       poids appris et score de classement
lib/auth.js        comptes Mora : mots de passe, double authentification, sessions, administration
lib/context.js     compte en cours pour chaque requête (multi-comptes)
lib/account.js     connexion du compte Claude de chaque compte (pilote `claude auth login`)
lib/discover-cli.js recherche via Claude Code (abonnement)
lib/discover.js    recherche via clé API (option) + image d'aperçu des pages
lib/demo.js        contenus d'exemple du mode démo
lib/translate.js   traduction en français des anciens titres
lib/usage.js       consommation de jetons de chaque appel à Claude (onglet Stats)
public/            interface (PWA : manifest + service worker, login.html)
Dockerfile         image Docker (+ docker/entrypoint.sh)
unraid/mora.xml    modèle de conteneur Unraid
```
