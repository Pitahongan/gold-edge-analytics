# Configurer les notifications Telegram — Gold Edge Analytics

## Ce que ça fait
Quand "Mon Edge" détecte un signal fort (ACHETER ou VENDRE, pas juste ATTENDRE),
vous recevez un message directement sur Telegram, sur votre téléphone. Vous n'avez
plus besoin d'avoir le dashboard ouvert pour être alerté.

---

## Étape 1 — Créer votre bot Telegram (2 minutes)

1. Ouvrez Telegram (sur votre téléphone ou sur telegram.org/desktop).
2. Cherchez le compte **@BotFather** (c'est le bot officiel de Telegram pour créer des bots — vérifiez le badge bleu).
3. Envoyez-lui la commande : `/newbot`
4. Il vous demande un **nom** (ex: `Gold Edge Alerts`) — tapez-le.
5. Il vous demande un **nom d'utilisateur** qui doit finir par `bot` (ex: `goldedge_pierre_bot`) — tapez-le.
6. BotFather vous répond avec un message contenant une ligne comme :
   ```
   Use this token to access the HTTP API:
   7123456789:AAHk3j2lKj4h5g6f7d8s9a0zA1B2C3D4E5F
   ```
   **Ce long code est votre `bot_token`.** Copiez-le.

## Étape 2 — Récupérer votre `chat_id` (1 minute)

1. Cherchez votre bot par son nom d'utilisateur (celui que vous avez choisi, ex: `@goldedge_pierre_bot`) et ouvrez la conversation avec lui.
2. Envoyez-lui n'importe quel message, par exemple : `salut`
3. Ouvrez cette adresse dans votre navigateur (remplacez `VOTRE_TOKEN` par le token de l'étape 1) :
   ```
   https://api.telegram.org/botVOTRE_TOKEN/getUpdates
   ```
4. Vous verrez une réponse JSON avec un champ `"chat":{"id":123456789, ...}` — **ce nombre est votre `chat_id`.** Copiez-le.

Si la réponse est vide (`"result":[]`), c'est probablement que vous n'avez pas encore envoyé de message au bot — retournez à l'étape 2.1.

## Étape 3 — Remplir config.json

Ouvrez `config.json` (dans le dossier de l'app) avec le Bloc-notes, et remplissez :

```json
{
  "fred_api_key": "...",
  "telegram_bot_token": "7123456789:AAHk3j2lKj4h5g6f7d8s9a0zA1B2C3D4E5F",
  "telegram_chat_id": "123456789"
}
```

(Gardez les guillemets, remplacez juste les valeurs entre `""`.)

## Étape 4 — Tester

Double-cliquez sur **`Test-Telegram.bat`**. Vous devriez recevoir un message de test sur Telegram en quelques secondes. Si ça ne marche pas, le script vous dira pourquoi (token ou chat_id incorrect généralement).

---

## Rendre ça VRAIMENT automatique (même dashboard fermé)

Par défaut, les notifications ne sont envoyées que quand `Update-Data.ps1` tourne
(donc quand vous lancez l'app ou cliquez sur "Actualiser"). Pour recevoir des
alertes même quand vous n'avez rien ouvert, il faut programmer son exécution
automatique avec le **Planificateur de tâches Windows** :

1. Ouvrez le menu Démarrer, tapez `Planificateur de tâches`, ouvrez-le.
2. Cliquez sur **"Créer une tâche de base..."** (panneau de droite).
3. Nom : `Gold Edge - Refresh Auto` → Suivant.
4. Déclencheur : `Tous les jours` → Suivant → choisissez une heure de départ (ex: 08:00) → Suivant.
5. Sur l'écran suivant, **cochez "Ouvrir la boîte de dialogue Propriétés..."** avant de cliquer sur Terminer.
6. Dans les Propriétés, onglet **Déclencheurs** → modifiez le déclencheur → cochez **"Répéter la tâche toutes les"** → `15 minutes` → **"pendant une durée de"** → `12 heures` (ou `Indéfiniment` si l'option existe).
7. Onglet **Actions** → Modifier :
   - Programme/script : `powershell.exe`
   - Ajouter des arguments : `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "CHEMIN_COMPLET\Update-Data.ps1"`

     (remplacez `CHEMIN_COMPLET` par le chemin réel, ex: `C:\Users\Pierre_VIDEGNON\Downloads\gold_edge_analytics_corrige\Update-Data.ps1`)
8. OK, puis OK. C'est fait.

Maintenant, même téléphone en poche et PC qui tourne en tâche de fond, vous recevrez
une alerte Telegram dès qu'un edge fort apparaît — sans avoir besoin d'ouvrir quoi
que ce soit.

---

## Important à savoir

- Ce calcul d'edge pour les notifications est une **version simplifiée** de "Mon Edge"
  (biais macro + momentum M15 + JPY/US10Y) — il ne reprend pas les 8 facteurs complets
  du dashboard (pas de RSI, inflation, liquidité). C'est fait exprès pour rester simple
  et fiable. **Considérez la notification comme un signal "allez vérifier le dashboard"**,
  pas comme un ordre de trade direct.
- Vous ne recevrez qu'**une seule notification par nouvel edge fort** (pas de spam à
  chaque exécution tant que rien n'a changé).
