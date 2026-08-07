# Script de mise à jour des données pour Gold Edge Analytics
# Récupère les données macro (FRED/Yahoo Daily) et les données intraday de Scalping (Yahoo M15)
#
# Tourne dans DEUX contextes :
#   - LOCAL (PC) : secrets lus dans config.json (fichier non versionné, cf. .gitignore).
#   - CLOUD (GitHub Actions) : secrets lus dans les variables d'environnement
#     (GitHub Secrets injectes par le workflow), config.json n'existe pas dans
#     le depot -> jamais de cle en clair commit. $env:GITHUB_ACTIONS vaut
#     "true" nativement sur les runners GitHub, sert a detecter le contexte
#     et a separer les fichiers d'etat/log (evite toute collision avec les
#     fichiers locaux lors d'un futur git pull).
$isCloud = $env:GITHUB_ACTIONS -eq 'true'

$configPath = Join-Path $PSScriptRoot "config.json"
$config = if (Test-Path $configPath) { Get-Content -Raw $configPath | ConvertFrom-Json } else { $null }

$fredApiKey = if ($env:FRED_API_KEY) { $env:FRED_API_KEY } else { $config.fred_api_key }
$telegramBotToken = if ($env:TELEGRAM_BOT_TOKEN) { $env:TELEGRAM_BOT_TOKEN } else { $config.telegram_bot_token }
$telegramChatId = if ($env:TELEGRAM_CHAT_ID) { $env:TELEGRAM_CHAT_ID } else { $config.telegram_chat_id }

if ([string]::IsNullOrEmpty($fredApiKey)) {
    Write-Error "Clé d'API FRED introuvable (ni config.json, ni `$env:FRED_API_KEY)."
    Exit
}

Write-Host "Collecte des données en cours..." -ForegroundColor Cyan

# En-tête de requête pour éviter d'être bloqué par Yahoo Finance
$headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# ==========================================
# 1. DONNÉES MACROÉCONOMIQUES (FRED)
# ==========================================
Write-Host "-> Téléchargement de FRED (DFII10, T10Y2Y et T5YIE)..." -ForegroundColor Yellow

$dfii10Url = "https://api.stlouisfed.org/fred/series/observations?series_id=DFII10&api_key=$fredApiKey&file_type=json&sort_order=desc&limit=400"
$t10y2yUrl = "https://api.stlouisfed.org/fred/series/observations?series_id=T10Y2Y&api_key=$fredApiKey&file_type=json&sort_order=desc&limit=400"
$t5yieUrl  = "https://api.stlouisfed.org/fred/series/observations?series_id=T5YIE&api_key=$fredApiKey&file_type=json&sort_order=desc&limit=400"

try {
    $dfii10Response = Invoke-RestMethod -Uri $dfii10Url -TimeoutSec 15
    $t10y2yResponse = Invoke-RestMethod -Uri $t10y2yUrl -TimeoutSec 15
    $t5yieResponse  = Invoke-RestMethod -Uri $t5yieUrl -TimeoutSec 15
} catch {
    Write-Error "Erreur lors du téléchargement des données FRED : $_"
    Exit
}

# Extraction des données FRED utiles en éliminant les valeurs "." (jours fériés)
$realYields = $dfii10Response.observations | Where-Object { $_.value -ne "." -and $_.value -ne $null } | ForEach-Object {
    [PSCustomObject]@{
        date  = $_.date
        value = [double]$_.value
    }
}

$yieldCurve = $t10y2yResponse.observations | Where-Object { $_.value -ne "." -and $_.value -ne $null } | ForEach-Object {
    [PSCustomObject]@{
        date  = $_.date
        value = [double]$_.value
    }
}

# T5YIE : anticipations d'inflation à 5 ans (breakeven). Complète le taux réel :
# taux nominal = taux réel + inflation anticipée. Une hausse du breakeven pendant
# que le taux réel stagne = signal classique du "debasement trade" (favorable or).
$breakevenInflation = $t5yieResponse.observations | Where-Object { $_.value -ne "." -and $_.value -ne $null } | ForEach-Object {
    [PSCustomObject]@{
        date  = $_.date
        value = [double]$_.value
    }
}

# ==========================================
# 2. COT MANAGED MONEY (CFTC — Disaggregated Futures Only Report)
# ==========================================
# Positionnement spéculatif COMEX Gold, catégorie "Managed Money" (fonds/CTA).
# Utilisé en CONTRARIAN : positionnement extrême = risque de dégagement.
# Rapport hebdomadaire (données au mardi, publiées le vendredi) -> lag
# structurel de quelques jours, assumé et documenté dans scoring-config.json.
Write-Host "-> Téléchargement du COT (CFTC Disaggregated, Gold Managed Money)..." -ForegroundColor Yellow

$cotResult = $null
try {
    $cotUrl = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json?" +
        "`$where=" + [uri]::EscapeDataString("market_and_exchange_names='GOLD - COMMODITY EXCHANGE INC.'") +
        "&`$order=" + [uri]::EscapeDataString("report_date_as_yyyy_mm_dd DESC") +
        "&`$limit=30"
    $cotResponse = Invoke-RestMethod -Uri $cotUrl -Headers $headers -TimeoutSec 15

    if ($cotResponse -and $cotResponse.Count -ge 8) {
        # Le plus récent est en premier (tri DESC) -> on inverse pour avoir chronologique
        $cotSorted = $cotResponse | Sort-Object report_date_as_yyyy_mm_dd
        $netSeries = $cotSorted | ForEach-Object {
            [double]$_.m_money_positions_long_all - [double]$_.m_money_positions_short_all
        }
        $currentNet = $netSeries[-1]
        $histNet = $netSeries[0..($netSeries.Count - 2)]  # exclut le point courant du calcul de la moyenne/écart-type
        $mean = ($histNet | Measure-Object -Average).Average
        $variance = ($histNet | ForEach-Object { [Math]::Pow($_ - $mean, 2) } | Measure-Object -Average).Average
        $stdDev = [Math]::Sqrt($variance)
        $netZ = if ($stdDev -gt 0) { ($currentNet - $mean) / $stdDev } else { 0 }

        $cotResult = [PSCustomObject]@{
            reportDate = $cotSorted[-1].report_date_as_yyyy_mm_dd
            netPosition = $currentNet
            netZ = [Math]::Round($netZ, 3)
        }
        Write-Host "   COT OK : net=$currentNet, z=$($cotResult.netZ) (rapport du $($cotResult.reportDate))" -ForegroundColor Green
    } else {
        Write-Warning "Réponse COT vide ou insuffisante pour calculer un z-score (besoin d'au moins 8 semaines d'historique)."
    }
} catch {
    Write-Warning "Erreur lors du téléchargement du COT (CFTC) : $_"
}

# ==========================================
# 3. DONNÉES QUOTIDIENNES (YAHOO FINANCE)
# ==========================================
$tickers = @{
    "Gold"   = "GC=F"
    "DXY"    = "DX-Y.NYB"
    "Oil"    = "CL=F"
    "VIX"    = "^VIX"
    "XLP"    = "XLP"
    "XLY"    = "XLY"
}

$dailyData = @{}

foreach ($key in $tickers.Keys) {
    $ticker = $tickers[$key]
    Write-Host "-> Téléchargement de Yahoo Finance (Daily $key [$ticker])..." -ForegroundColor Yellow
    
    $yfUrl = "https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d"
    try {
        $yfResponse = Invoke-RestMethod -Uri $yfUrl -Headers $headers -TimeoutSec 15
        $result = $yfResponse.chart.result[0]
        
        $timestamps = $result.timestamp
        $quotes = $result.indicators.quote[0]
        $adjClose = $result.indicators.adjclose[0].adjclose
        
        $candles = @()
        for ($i = 0; $i -lt $timestamps.Count; $i++) {
            $closeVal = $quotes.close[$i]
            if ($adjClose -and $adjClose[$i] -ne $null) {
                $closeVal = $adjClose[$i]
            }
            
            if ($timestamps[$i] -and $quotes.open[$i] -ne $null -and $closeVal -ne $null) {
                $candles += [PSCustomObject]@{
                    time  = $timestamps[$i]
                    open  = [double]$quotes.open[$i]
                    high  = [double]$quotes.high[$i]
                    low   = [double]$quotes.low[$i]
                    close = [double]$closeVal
                }
            }
        }
        if ($candles.Count -eq 0) {
            Write-Warning "Aucune bougie valide reçue pour $key ($ticker). Yahoo Finance a peut-être bloqué la requête ou changé de format."
        }
        $dailyData[$key] = $candles
    } catch {
        Write-Warning "Erreur lors du téléchargement de $key ($ticker) : $_"
    }
    Start-Sleep -Milliseconds 400
}

# ==========================================
# 4. DONNÉES INTRADAY M15 (YAHOO FINANCE)
# ==========================================
$m15Tickers = @{
    "Gold"  = "GC=F"
    "JPY"   = "JPY=X"
    "US10Y" = "^TNX"
}

$m15Data = @{}

foreach ($key in $m15Tickers.Keys) {
    $ticker = $m15Tickers[$key]
    Write-Host "-> Téléchargement de Yahoo Finance (M15 $key [$ticker])..." -ForegroundColor Yellow

    # Gold seul a besoin d'une fenetre plus longue : sert aussi a deriver le H4
    # (filtre de confirmation de tendance, cf. AUDIT-CORRECTIONS.md) qui a besoin
    # d'au moins 50+confirmCandles bougies H4 pour un EMA50 valide, soit ~9j
    # d'historique M15 minimum. Yahoo accepte range=60d en interval=15m sur
    # GC=F (teste), on prend 15d pour une marge confortable sans alourdir inutilement.
    $m15Range = if ($key -eq "Gold") { "15d" } else { "5d" }
    $yfUrl = "https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=$m15Range&interval=15m"
    try {
        $yfResponse = Invoke-RestMethod -Uri $yfUrl -Headers $headers -TimeoutSec 15
        $result = $yfResponse.chart.result[0]
        
        $timestamps = $result.timestamp
        $quotes = $result.indicators.quote[0]
        
        $candles = @()
        for ($i = 0; $i -lt $timestamps.Count; $i++) {
            if ($timestamps[$i] -and $quotes.open[$i] -ne $null -and $quotes.close[$i] -ne $null) {
                $candles += [PSCustomObject]@{
                    time  = $timestamps[$i]
                    open  = [double]$quotes.open[$i]
                    high  = [double]$quotes.high[$i]
                    low   = [double]$quotes.low[$i]
                    close = [double]$quotes.close[$i]
                }
            }
        }
        if ($candles.Count -eq 0) {
            Write-Warning "Aucune bougie M15 valide reçue pour $key ($ticker). Yahoo Finance a peut-être bloqué la requête ou changé de format."
        }
        $m15Data[$key] = $candles
    } catch {
        Write-Warning "Erreur lors du téléchargement de M15 $key ($ticker) : $_"
    }
    Start-Sleep -Milliseconds 400
}

# ==========================================
# 4bis. AGRÉGATION H4 (GOLD UNIQUEMENT) — filtre de confirmation de tendance
# ==========================================
# Le systeme n'a pas de flux H4 dedie : on le derive du M15 Gold (fenetre
# etendue ci-dessus) par agregation de blocs de 4h alignes sur l'epoch UTC
# (arithmetique entiere pure, pas de Get-Date -> evite tout piege de fuseau
# horaire local / DST / arrondi milliseconde). La derniere bougie H4 est
# ecartee si elle n'est pas encore complete (bloc de 4h pas termine), meme
# logique anti-repaint que dropLastCandle pour le M15.
$h4Gold = @()
if ($m15Data.ContainsKey("Gold") -and $m15Data["Gold"].Count -gt 0) {
    $h4Buckets = [ordered]@{}
    foreach ($c in ($m15Data["Gold"] | Sort-Object time)) {
        $bucketEpoch = [long]([Math]::Floor([long]$c.time / 14400) * 14400)
        if (-not $h4Buckets.Contains($bucketEpoch)) {
            $h4Buckets[$bucketEpoch] = [PSCustomObject]@{
                time  = $bucketEpoch
                open  = $c.open
                high  = $c.high
                low   = $c.low
                close = $c.close
                count = 1
            }
        } else {
            $b = $h4Buckets[$bucketEpoch]
            $b.high = [Math]::Max($b.high, $c.high)
            $b.low  = [Math]::Min($b.low, $c.low)
            $b.close = $c.close
            $b.count++
        }
    }
    $h4Gold = @($h4Buckets.Values | Sort-Object time)
    $nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($h4Gold.Count -gt 0 -and ($h4Gold[-1].count -lt 4 -or ($h4Gold[-1].time + 14400) -gt $nowEpoch)) {
        $h4Gold = @($h4Gold[0..($h4Gold.Count - 2)])
    }
    Write-Host "-> H4 Gold dérivé du M15 : $($h4Gold.Count) bougies utilisables" -ForegroundColor Yellow
} else {
    Write-Warning "Impossible de dériver le H4 Gold : M15 Gold absent ou vide."
}

# ==========================================
# 5. ASSEMBLAGE ET ÉCRITURE
# ==========================================
Write-Host "-> Assemblage et écriture de data.js..." -ForegroundColor Yellow

$h4DataForExport = @{
    Gold = @($h4Gold | ForEach-Object {
        [PSCustomObject]@{ time = $_.time; open = $_.open; high = $_.high; low = $_.low; close = $_.close }
    })
}

$marketDataObj = [PSCustomObject]@{
    updatedAt           = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    realYields          = $realYields
    yieldCurve          = $yieldCurve
    breakevenInflation  = $breakevenInflation
    dailyData           = $dailyData
    m15Data             = $m15Data
    h4Data              = $h4DataForExport
    cot                 = $cotResult
}

$jsonData = $marketDataObj | ConvertTo-Json -Depth 10
$jsContent = "window.MARKET_DATA = $jsonData;"

$dataJsPath = Join-Path $PSScriptRoot "data.js"
[System.IO.File]::WriteAllText($dataJsPath, $jsContent)

Write-Host "Données mises à jour avec succès à $dataJsPath !" -ForegroundColor Green

# NOTE : ce script n'ouvre plus le navigateur lui-même. C'est Server.ps1 qui
# s'en charge (une seule fois, au démarrage, via http://localhost:8934/).
# Sans ça, chaque clic sur "Actualiser" ouvrait un 2e onglet en double
# (file://... en plus de celui du serveur local).

# ==========================================
# 6. NOTIFICATIONS (Telegram + Windows) — Edge Fort ET Modéré
# ==========================================
try {
    . (Join-Path $PSScriptRoot "Edge-Score.ps1")
    . (Join-Path $PSScriptRoot "Telegram-Notify.ps1")
    . (Join-Path $PSScriptRoot "Windows-Notify.ps1")

    $edge = Get-SimplifiedEdgeScore `
        -DailyGold $dailyData["Gold"] -DailyDxy $dailyData["DXY"] -DailyOil $dailyData["Oil"] `
        -DailyXlp $dailyData["XLP"] -DailyXly $dailyData["XLY"] `
        -RealYields $realYields -YieldCurve $yieldCurve -BreakevenInflation $breakevenInflation `
        -M15Gold $m15Data["Gold"] -M15Jpy $m15Data["JPY"] -M15Us10y $m15Data["US10Y"] `
        -H4Gold $h4Gold `
        -Cot $cotResult -ScriptRoot $PSScriptRoot

    Write-Host "-> Edge simplifié (pour notifications) : $($edge.verdict) | score $($edge.score)/$($edge.maxScore)" -ForegroundColor Cyan

    # Journal : une ligne à CHAQUE exécution (contrairement à Telegram qui ne
    # notifie que sur un edge fort NOUVEAU). Sert à vérifier que le pipeline
    # tourne bien même quand il n'y a rien de fort à signaler.
    # Fichier distinct en contexte cloud (edge_log.cloud.txt, versionné et
    # committé par le workflow) pour ne jamais entrer en collision avec le
    # edge_log.txt local (non versionné) lors d'un futur git pull/push.
    $logFilePath = Join-Path $PSScriptRoot $(if ($isCloud) { "edge_log.cloud.txt" } else { "edge_log.txt" })
    $logLine = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | verdict=$($edge.verdict) | score=$($edge.score)/$($edge.maxScore) | macro=$($edge.macroScore)% | goldTrend=$($edge.goldTrend) | h4Trend=$($edge.h4Trend) | jpyTrend=$($edge.jpyTrend) | us10yTrend=$($edge.us10yTrend) | nearSupport=$($edge.nearSupport) | nearResistance=$($edge.nearResistance) | cotZ=$($edge.cotNetZ)"
    Add-Content -Path $logFilePath -Value $logLine -Encoding UTF8

    # On garde seulement les 500 dernières lignes pour ne pas que le fichier grossisse indéfiniment
    $logLines = Get-Content -Path $logFilePath
    if ($logLines.Count -gt 500) {
        $logLines | Select-Object -Last 500 | Set-Content -Path $logFilePath -Encoding UTF8
    }

    # Etat de dedup distinct en contexte cloud (notify_state.cloud.json,
    # versionné/committé par le workflow) -> le PC local et le cloud ont
    # chacun leur propre etat de notification, jamais de collision au pull.
    # Consequence assumee : si PC et cloud tournent en meme temps, chacun
    # peut notifier independamment sur le meme evenement (rare doublon
    # possible) -> largement prefere a un signal manque quand le PC est eteint.
    $stateFilePath = Join-Path $PSScriptRoot $(if ($isCloud) { "notify_state.cloud.json" } else { "notify_state.json" })
    $lastNotifiedVerdict = $null
    if (Test-Path $stateFilePath) {
        try {
            $lastState = Get-Content -Raw $stateFilePath | ConvertFrom-Json
            $lastNotifiedVerdict = $lastState.verdict
        } catch { $lastNotifiedVerdict = $null }
    }

    $isStrongEdge = ($edge.verdict -eq 'buy' -or $edge.verdict -eq 'sell') -and ($edge.strength -eq 'strong' -or $edge.strength -eq 'moderate')

    # Etat notifie = direction + force combinees (ex: "sell-moderate"), pour
    # renvoyer une notif si le signal passe de Modere a Fort (ou inversement)
    # sur la meme direction, sans spammer tant que rien ne change vraiment.
    $currentState = "$($edge.verdict)-$($edge.strength)"

    # On ne notifie QUE si l'etat fort/modere est NOUVEAU (different du dernier notifie),
    # pour ne pas spammer le téléphone à chaque exécution tant que rien n'a changé.
    if ($isStrongEdge -and $currentState -ne $lastNotifiedVerdict) {
        $goldPrice = ($m15Data["Gold"] | Sort-Object time | Select-Object -Last 1).close
        $directionLabel = if ($edge.verdict -eq 'buy') { "ACHAT (BUY)" } else { "VENTE (SELL)" }
        $strengthLabel = if ($edge.strength -eq 'strong') { "Fort" } else { "Modere" }

        $message = @"
<b>GOLD EDGE - Edge $strengthLabel detecte</b>

Direction : <b>$directionLabel</b>
Force : <b>$strengthLabel</b>
Prix Or (M15) : `$$($goldPrice.ToString('0.00'))
Score : $($edge.score) / $($edge.maxScore)
Biais Macro : $($edge.macroScore)%
Momentum M15 : $($edge.goldTrend) (confirmé H4 : $($edge.h4Trend))
COT Managed Money (z-score) : $(if ($null -ne $edge.cotNetZ) { $edge.cotNetZ } else { 'n/a (donnee indisponible cette semaine)' })

Ouvrez le dashboard pour le detail complet (7 facteurs independants, ATR, suivi de position) avant de trader.
"@

        Send-TelegramMessage -BotToken $telegramBotToken -ChatId $telegramChatId -Message $message | Out-Null

        # Notification Windows en plus de Telegram (backup si le telephone
        # n'est pas a portee) : echec silencieux tolere, Telegram reste la
        # notification garantie.
        Send-WindowsToast `
            -Title "GOLD EDGE - Edge $strengthLabel : $directionLabel" `
            -Message "Prix $($goldPrice.ToString('0.00'))$ | Score $($edge.score)/$($edge.maxScore) | Macro $($edge.macroScore)% | M15 $($edge.goldTrend) (H4 $($edge.h4Trend))" `
            | Out-Null

        [PSCustomObject]@{ verdict = $currentState; notifiedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") } |
            ConvertTo-Json | Set-Content -Path $stateFilePath
    }
    elseif (-not $isStrongEdge -and $lastNotifiedVerdict) {
        # HYSTERESIS : on ne reinitialise l'etat QUE si le score est
        # clairement redescendu (moins de 65% du seuil Modere), pas juste
        # repasse sous le seuil de justesse. Sans ca, un score qui oscille
        # autour de la ligne (ex: 2.24 / 2.26 / 2.20...) declenche une
        # nouvelle alerte a CHAQUE fois qu'il la refranchit, alors que
        # c'est la meme thèse de marche depuis le debut - c'est exactement
        # la rafale de SELL quasi-identiques observee le 03/08.
        $disarmThreshold = $edge.moderateCut * 0.65
        if ([Math]::Abs($edge.score) -lt $disarmThreshold) {
            # NOTIFICATION DE RETOUR AU NEUTRE : avant, cet etat se reinitialisait
            # en silence -> l'utilisateur gardait une alerte BUY/SELL "active" sur
            # son telephone alors que le systeme etait deja repasse a ATTENDRE
            # depuis longtemps (source de confusion confirmee le 07/08 : alerte
            # VENTE recue, dashboard deja neutre au moment de la consultation).
            $expiredDirectionLabel = if ($lastNotifiedVerdict -like 'buy-*') { "ACHAT" } else { "VENTE" }
            $expiredMessage = @"
<b>GOLD EDGE - Signal expire</b>

La these <b>$expiredDirectionLabel</b> notifiee precedemment n'est plus valide : le score est repasse en zone neutre (ATTENDRE).
Score actuel : $($edge.score) / $($edge.maxScore)

Ne pas se fier a l'alerte precedente pour une nouvelle entree.
"@
            Send-TelegramMessage -BotToken $telegramBotToken -ChatId $telegramChatId -Message $expiredMessage | Out-Null
            Send-WindowsToast `
                -Title "GOLD EDGE - Signal expire" `
                -Message "La these $expiredDirectionLabel n'est plus valide (retour a ATTENDRE). Score actuel $($edge.score)/$($edge.maxScore)." `
                | Out-Null

            [PSCustomObject]@{ verdict = $null; notifiedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") } |
                ConvertTo-Json | Set-Content -Path $stateFilePath
        }
    }
} catch {
    Write-Warning "Le calcul de l'edge simplifié ou la notification Telegram a échoué (le dashboard reste inchangé) : $_"
}
