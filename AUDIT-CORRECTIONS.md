# Gold Edge Analytics — Corrections appliquées

Référence : audit du 13/07/2026. Chaque point ci-dessous correspond à un problème identifié, avec le fix réellement livré dans ce package.

## 1. Multicolinéarité (JPY + US10Y comptaient 2x le même facteur taux/dollar)
**Fix :** `computeUnifiedVerdict()` (app.js) et `Get-SimplifiedEdgeScore` (Edge-Score.ps1) fusionnent désormais JPY et US10Y en UNE seule confirmation cross-asset (poids `crossAssetConfirm`, défaut 1) :
accord des deux = poids plein, un seul disponible = poids demi, désaccord = neutre.
RSI M15 ne s'additionne plus au momentum EMA M15 (même information, transformée deux fois) : il reste affiché comme drapeau de prudence (surachat/survente tardif) mais n'ajoute plus de points.

## 2. Zéro backtest, poids arbitraires
**Fix :** `Backtest-MacroBias.py` — teste empiriquement la brique macro (real yields, DXY, yield curve, XLP/XLY) sur les données réellement présentes dans `data.js`, sans look-ahead. **Résultat obtenu sur votre snapshot actuel (505 jours, 07/2024→07/2026) :** corrélation quasi nulle (0.001 à 5j, 0.05 à 20j) entre le score macro et le rendement forward de l'or, et le bucket "bearish" affiche un win-rate directionnel de 35-38% seulement — c'est-à-dire que quand le système dit "baissier", l'or est monté dans ~63% des cas sur cet échantillon. C'est un marché haussier structurel sur la période, qui écrase le signal du filtre macro tel que pondéré actuellement. À relancer régulièrement à mesure que l'historique s'accumule, et à interpréter comme signal d'ajustement des poids/seuils, pas comme un verdict définitif sur 2 ans de données.

## 3. Deux moteurs de scoring divergents (dashboard vs Telegram)
**Fix :** `scoring-config.json` — fichier unique chargé par `app.js` (fetch) ET `Edge-Score.ps1` (Get-Content). Les poids ne peuvent plus diverger. Limite assumée et documentée dans le code : le moteur PS1 ne reproduit pas le facteur "Liquidité Intraday" (dépend de niveaux de session calculés côté dashboard) — son maxScore effectif est donc réduit en conséquence, pas juste tronqué silencieusement.

## 4. Aucun tracking de performance réalisée
**Fix :** Nouvelle carte "Journal & Stats" dans le dashboard. `handleCloseTradeClick()` demande désormais un prix de sortie, calcule le R réalisé (delta prix / ATR d'entrée), et l'archive dans `localStorage` (`goldEdgeTradeHistory`, 500 derniers trades). Le panneau affiche win rate, gain moyen / perte moyenne, et expectancy en R par trade — avec un avertissement explicite sous 30 trades.

## 5. Repaint sur la bougie M15 en formation
**Fix :** `getM15Trend()` (app.js) et `Get-StableTrend` (Edge-Score.ps1) excluent systématiquement la dernière bougie M15 (généralement non clôturée chez Yahoo) avant de calculer EMA9/50 et la tendance. Contrôlé par `m15Trend.dropLastCandle` dans `scoring-config.json`.

## 6. Panne de données confondue avec signal neutre
**Fix :** `processMarketData()` calcule désormais un objet `dataHealth` (présence + âge de chaque série critique : Gold daily, Gold M15, real yields, DXY). Si une série critique est absente ou dépasse `staleAfterHours` (défaut 30h), le verdict est forcé à **"ATTENDRE — Données Indisponibles"** avec la liste explicite des séries en cause, plus un bandeau rouge en haut du dashboard. Ce n'est plus jamais silencieusement traité comme un marché neutre.

## 7. Label trompeur "Scalp M1" sur un stop basé sur l'ATR daily
**Fix :** Renommé en "Achat/Vente Immédiat (Intraday, hold ≤24h)", cohérent avec la logique de risk management existante (stop = 1x ATR quotidien, hold max 24h documenté dans le suivi de thèse).

## 8. COT disparu silencieusement
**Fix :** `Update-Data.ps1` récupère maintenant le vrai rapport CFTC Disaggregated (COMEX Gold, catégorie Managed Money) via l'API publique Socrata, calcule un z-score du net position sur 26 semaines, et l'intègre en facteur contrarian indépendant (poids `cotContrarian`, défaut 1) dans les deux moteurs de scoring. Lag structurel de ~3 jours documenté et assumé (poids volontairement limité).

## Point non technique — secrets exposés dans config.json
`config.json` contient en clair une clé API FRED et un token de bot Telegram. Ces valeurs sont maintenant passées par ce chat pour l'audit. **Recommandation : régénérez le token Telegram (BotFather → /revoke) et la clé FRED avant de redéployer**, et ne committez jamais ce fichier dans un dépôt partagé — ajoutez-le à `.gitignore` si vous versionnez ce projet.

## Ce qui n'a PAS été changé
- La méthode Wilder pour RSI/ATR/EMA était déjà correcte — aucune modification.
- La checklist macro affichée dans la jauge (`evaluateMacroChecklist`) reste inchangée dans sa logique de calcul ; elle alimente directement `macroScore` utilisé par le verdict unifié, donc les corrections ci-dessus s'y répercutent déjà.
- Aucune modification du flux Yahoo Finance lui-même (toujours un scraping non officiel, sans clé — risque de blocage/format cassé qui subsiste ; le `dataHealth` en atténue l'impact mais ne l'élimine pas).
