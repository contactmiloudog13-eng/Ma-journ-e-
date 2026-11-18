# 📺 Télécommande Samsung

Une télécommande pour TV Samsung, utilisable depuis ton téléphone (ou un ordinateur) sur le Wi-Fi de la maison.

- Croix directionnelle, OK, retour, accueil, menu, source
- Volume, chaînes, muet, guide, pavé numérique, touches couleur, lecture/pause
- Appui long sur volume, chaînes et flèches pour répéter la touche
- Lancement des applis (Netflix, YouTube…)
- Saisie de texte sur la TV (recherche YouTube, Netflix…)
- Allumage de la TV à distance (Wake-on-LAN)
- Recherche automatique de la TV sur le réseau

**TV compatibles :** Samsung Smart TV sous Tizen, c'est-à-dire **les modèles de 2016 et plus récents**.

## Comment ça marche

```
Téléphone  ──Wi-Fi──▶  PC (cette appli)  ──réseau local──▶  TV Samsung
(navigateur)            node server.js                    (ports 8001/8002)
```

Les TV Samsung n'acceptent les commandes que par une connexion sécurisée, avec un certificat que les navigateurs des téléphones refusent. L'appli tourne donc sur un PC de la maison (ou un Raspberry Pi), transmet les commandes à la TV et affiche la télécommande sur ton téléphone.

## Installation

1. Installe **Node.js** (version 18 ou plus) : https://nodejs.org
2. Dans un terminal, ouvre ce dossier puis lance :

   ```bash
   npm install
   npm start
   ```

3. Le terminal affiche une adresse du genre `http://192.168.1.42:3000`.
   **Ouvre-la sur ton téléphone** (connecté au même Wi-Fi).
4. Dans les réglages de l'appli :
   - touche **Rechercher ma TV** (ou saisis son adresse IP) ;
   - touche **Enregistrer et associer** ;
   - **sur la TV**, choisis **Autoriser** dans la fenêtre qui s'affiche.

C'est prêt ! L'association est mémorisée dans `config.json` : tu n'auras pas à la refaire.

> 💡 Sur iPhone : Safari › Partager › **Sur l'écran d'accueil**. Sur Android : Chrome › ⋮ › **Ajouter à l'écran d'accueil**. La télécommande s'ouvre alors comme une vraie appli.

## Réglages conseillés sur la TV

| Pour… | Réglage (le chemin varie selon l'année du modèle) |
| --- | --- |
| Allumer la TV depuis le téléphone | Paramètres › Général › Réseau › Paramètres experts › **Allumer avec le mobile** : activé |
| Débloquer la télécommande refusée | Paramètres › Général › **Gestionnaire de périphériques externes** › Gestionnaire de connexion des périphériques › autoriser « Ma telecommande » |
| Éviter que l'adresse change | Dans l'interface de ta box : **bail DHCP fixe / IP réservée** pour la TV |

L'adresse IP de la TV se trouve dans Paramètres › Général › Réseau › **État du réseau**.

## Dépannage

- **« TV injoignable »** : la TV est éteinte, ou elle et le PC ne sont pas sur la même box. Vérifie aussi son adresse IP.
- **La recherche ne trouve rien** : certaines box bloquent la découverte réseau. Saisis l'adresse IP à la main.
- **Le bouton marche/arrêt n'allume pas la TV** : active « Allumer avec le mobile » (voir plus haut). L'adresse MAC doit être renseignée ; elle l'est automatiquement si la TV était allumée lors de l'association. Si le PC est en Wi-Fi, l'allumage marche mieux avec la TV branchée en câble Ethernet.
- **Le téléphone n'arrive pas à ouvrir la page** : le pare-feu du PC bloque peut-être le port 3000. Sous Windows, accepte la demande « Autoriser l'accès » à Node.js sur les réseaux privés.
- **La liste des applis est générique** : certaines TV récentes ne donnent pas leur liste. L'appli propose alors les plus courantes.

## Options

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port de la page web |
| `CONFIG_PATH` | `./config.json` | Fichier où sont mémorisés la TV et son jeton |

Exemple : `PORT=8080 npm start`

## Sécurité

Toute personne connectée à ton Wi-Fi peut ouvrir la page et piloter la TV, comme avec une télécommande posée sur la table. L'appli n'est pas faite pour être exposée sur Internet.

## Structure

```
server.js            serveur web + API (/api/key, /api/power, /api/apps…)
lib/samsung-tv.js    dialogue avec la TV (WebSocket, jeton, Wake-on-LAN)
lib/discovery.js     recherche de la TV sur le réseau
public/index.html    la télécommande (page mobile)
```
