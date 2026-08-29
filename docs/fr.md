# Netatmo iDiamant

Cette intégration pilote vos volets Bubendorff équipés d'une passerelle **iDiamant with Netatmo** depuis Gladys Assistant : ouverture, fermeture, arrêt, position au pourcentage, et remontée de la position réelle dans le tableau de bord et les scènes.

## Ce qui est pris en charge

- Volets roulants Bubendorff (`NBR`)
- Volets orientables / BSO (`NBO`) — pilotage de la hauteur uniquement, pas de l'orientation des lames
- Volets battants (`NBS`)
- Position de 0 % (fermé) à 100 % (ouvert), commande d'arrêt en cours de course
- Qualité du signal radio de chaque volet, et niveau de batterie sur les modèles qui en remontent un

Les interrupteurs et prises Legrand / BTicino ne sont pas concernés : ils passent par d'autres scopes de l'API Netatmo.

## Prérequis

- Une passerelle iDiamant déjà installée, et vos volets déjà appairés et fonctionnels dans l'application **Home + Control** (Legrand / Netatmo / BTicino). L'intégration ne fait pas l'appairage.
- Un compte développeur Netatmo, gratuit, créé avec **les mêmes identifiants** que l'application.
- Une connexion Internet : l'API iDiamant est exclusivement cloud, il n'existe pas d'API locale. Sans Internet, les volets restent pilotables par leurs télécommandes, mais pas par Gladys.

## Configuration

### 1. Créer une application Netatmo

Rendez-vous sur [dev.netatmo.com](https://dev.netatmo.com/apps/createanapp), connectez-vous, puis créez une application. Les champs demandés (nom, description, nom et email du responsable des données) sont libres.

Une fois l'application enregistrée, la section « App Technical Parameters » affiche votre **client ID** et votre **client secret**.

### 2. Renseigner Gladys

Dans l'onglet **Configuration** de l'intégration :

1. Collez le client ID et le client secret, puis enregistrez.
2. Gladys affiche l'**URL de redirection** à déclarer. Copiez-la et ajoutez-la dans les paramètres de votre application Netatmo, à l'octet près. C'est l'erreur la plus fréquente : une URL qui diffère d'un caractère fait échouer la connexion avec `redirect_uri_mismatch`.
3. Cliquez sur **Connecter**. Vous êtes renvoyé vers Netatmo, qui vous demande d'autoriser l'accès aux volets (scopes `read_bubendorff` et `write_bubendorff`), puis vous ramène dans Gladys.

### 3. Créer les appareils

Ouvrez l'onglet **Découverte** et lancez un scan. Vos volets apparaissent avec leur nom et leur pièce tels que définis dans Home + Control. Cliquez sur « créer » pour chacun de ceux que vous voulez utiliser.

Chaque volet expose :

| Fonctionnalité | Description |
| --- | --- |
| Ouverture / Fermeture | Boutons ouvrir, arrêter, fermer |
| Position | Curseur de 0 à 100 % |
| Qualité du signal | Qualité radio entre le volet et la passerelle, en % |
| Batterie | Uniquement sur les volets qui la remontent |

### 4. Fréquence de rafraîchissement

Netatmo ne pousse aucun événement pour les volets : l'intégration interroge l'API à intervalle régulier. Une minute est un bon compromis. Après chaque commande envoyée depuis Gladys, l'état est de toute façon relu automatiquement plusieurs fois pendant les trente secondes qui suivent, le temps que le volet finisse sa course.

L'API Netatmo est limitée à 500 requêtes par heure et par utilisateur. Un rafraîchissement toutes les minutes en consomme environ 60, il reste donc largement de la marge, y compris si vous utilisez le même compte Netatmo ailleurs.

## Boutons d'action

- **Tester la connexion** : vérifie les identifiants et affiche le nombre de volets trouvés.
- **Rafraîchir les états maintenant** : force une relecture immédiate.
- **Mettre tous les volets en position préférée** : envoie la position favorite enregistrée dans chaque volet Bubendorff (la fonction « position préférée » de la télécommande).

## Dépannage

**« Compte Netatmo non relié »** — le client ID ou le client secret est absent, ou la connexion OAuth2 n'a jamais abouti. Enregistrez d'abord les identifiants, puis cliquez sur Connecter.

**La connexion échoue avec `redirect_uri_mismatch`** — l'URL de redirection déclarée chez Netatmo ne correspond pas exactement à celle affichée par Gladys. Recopiez-la telle quelle, sans slash final ajouté ou retiré.

**« API Netatmo injoignable »** — le token a expiré et n'a pas pu être renouvelé. Le refresh token Netatmo est à usage unique et tourne à chaque renouvellement ; s'il a été consommé ailleurs (une autre intégration utilisant la même application Netatmo, par exemple), il faut recliquer sur Connecter. Créez de préférence une application Netatmo distincte par outil.

**Aucun volet dans l'onglet Découverte** — vérifiez que les volets sont bien visibles dans Home + Control avec le compte utilisé, et que la passerelle iDiamant est en ligne.

**Un volet est marqué injoignable** — la passerelle ne voit plus le volet en radio. Regardez la fonctionnalité « Qualité du signal » : sous 20 %, la liaison est trop faible et un répéteur ou un déplacement de la passerelle s'impose.

**La position affichée ne bouge pas tout de suite** — c'est normal. Netatmo ne renvoie la position définitive qu'une fois le volet arrêté, et la course prend une vingtaine de secondes.
