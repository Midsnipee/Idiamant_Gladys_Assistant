# gladys-netatmo-idiamant

Intégration externe Gladys Assistant pour les volets Bubendorff pilotés par une passerelle **iDiamant with Netatmo**.

La documentation utilisateur est dans [`docs/fr.md`](docs/fr.md) et [`docs/en.md`](docs/en.md) — ce sont les deux fichiers que le store ré-héberge, ils sont obligatoires.

## Structure

| Fichier | Rôle |
| --- | --- |
| `gladys-assistant-integration.json` | Manifeste : type, config_schema OAuth2, actions, catégories |
| `src/netatmo.js` | Client Netatmo Connect : OAuth2, `homesdata`, `homestatus`, `setstate` |
| `src/mapping.js` | Traduction module Netatmo ↔ appareil et fonctionnalités Gladys |
| `src/index.js` | Câblage des handlers du SDK, boucle de polling, gestion d'état |
| `test/smoke.mjs` | Tests avec une API Netatmo simulée |

## Choix techniques

**Cloud uniquement.** Netatmo n'expose aucune API locale pour l'iDiamant, d'où `"transports": ["cloud"]` dans le manifeste. Chaque volet publie son transport à chaque rafraîchissement (`cloud`, ou `unreachable` quand la passerelle ne le voit plus).

**Le refresh token tourne.** Netatmo invalide le refresh token à chaque usage et en renvoie un nouveau. `NetatmoClient` appelle `onTokens` immédiatement, et l'intégration le persiste via `gladys.setConfig()` avant même de s'en servir. Les rafraîchissements concurrents sont sérialisés sur une seule promesse : sinon trois commandes simultanées consomment le même token et deux échouent définitivement.

**Publication des changements seulement.** L'API hôte limite à 300 états par minute et par intégration. `lastPublished` garde la dernière valeur envoyée par fonctionnalité et le lot ne contient que ce qui a bougé.

**Correspondance des valeurs.**

| Gladys | Valeur | Netatmo `target_position` |
| --- | --- | --- |
| `shutter/state` | `1` (ouvert) | `100` |
| `shutter/state` | `-1` (fermé) | `0` |
| `shutter/state` | `0` (stop) | `-1` |
| `shutter/position` | `0`–`100` | identique |
| Bouton d'action | position préférée | `-2` |

En lecture, `current_position` est reconverti : `100` → ouvert, `0` → fermé, entre les deux → stop.

Le `rf_strength` de Netatmo décroît quand le signal s'améliore (≈60 excellent, ≈90 limite). Il est inversé en un pourcentage de qualité pour que la fonctionnalité `signal/quality` se lise dans le bon sens.

**Relecture après commande.** Netatmo ne pousse rien et un volet met une vingtaine de secondes à parcourir sa course. Après chaque `setstate`, l'état est relu à 4 s, 12 s et 30 s, en plus de la boucle de polling.

## Développement

```bash
npm install
npm test
```

Pour tourner contre une instance Gladys réelle, installez l'intégration en mode développeur pour obtenir un token et un selector, puis :

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="netatmo-idiamant" \
LOG_LEVEL=debug \
npm start
```

Valider le manifeste avec exactement les règles de l'indexeur :

```bash
npx github:GladysAssistant/integration-store .
```

## Publication

1. Remplacez `midsnipee` dans `docker_image` par votre compte, ou laissez le workflow le faire (il calcule l'image depuis `GITHUB_REPOSITORY`).
2. Ajoutez le topic GitHub **`gladys-assistant-integration`** au dépôt : c'est ce qui le rend découvrable par l'indexeur.
3. Optionnel mais recommandé : commitez une `cover.jpg` de 800 × 534 px, moins de 150 Ko, et pointez `cover_image` sur son URL `raw.githubusercontent.com`.
4. Onglet **Actions** → workflow **Release** → choisissez `patch`, `minor` ou `major`. Il incrémente la version, met à jour le manifeste, valide, tague, construit l'image `linux/amd64` + `linux/arm64` et la pousse sur `ghcr.io`.
5. Rendez le package GHCR **public**, sinon l'indexeur ne peut pas télécharger l'image anonymement.

L'indexeur passe toutes les heures. En cas d'absence du catalogue, le `rejected.json` publié indique la raison.

## Limites connues

- L'orientation des lames des BSO (`NBO`) n'est pas exposée : seule la hauteur l'est.
- Les interrupteurs, prises et modules Legrand / BTicino sont hors périmètre (autres scopes de l'API).
- L'API Netatmo plafonne à 500 requêtes/heure/utilisateur. Un rafraîchissement par minute en consomme ~60.

## Tester

Voir la section « Développement » plus haut pour la boucle Gladys. Avant ça, la sonde
`npm run probe` interroge votre compte Netatmo et affiche ce que l'intégration en
ferait, sans Gladys ni Docker :

```bash
NETATMO_ACCESS_TOKEN=<token du Token generator> npm run probe
```

Elle liste aussi les champs remontés par `/homestatus` que l'intégration n'exploite
pas encore — c'est là qu'on repère, par exemple, l'orientation des lames d'un BSO.

`npm run probe -- --move 50` envoie une vraie commande au premier volet trouvé.
Le volet bouge physiquement.
