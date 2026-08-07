# ===================================================================
# Edge-Score.ps1
# ===================================================================
# Miroir du calcul "Mon Edge" du dashboard (computeUnifiedVerdict dans
# app.js). Les deux moteurs chargent le MEME fichier scoring-config.json :
# les poids ne peuvent plus diverger entre Telegram et le dashboard.
#
# Historique (corrige le 07/08/2026) : la "Liquidite Intraday" (proximite
# PDH/PDL/session asiatique) n'etait pas reproduite ici et traitee comme
# neutre en permanence -> pouvait faire declencher une alerte Telegram sur
# un score que le dashboard, avec ce facteur en plus, classait encore en
# ATTENDRE (et inversement) : les deux moteurs pouvaient diverger au meme
# instant, pas seulement a cause du delai entre deux rafraichissements.
# Desormais reproduite a l'identique (PDH/PDL = bougie quotidienne de la
# veille, Asia High/Low = M15 du jour entre 00h-08h UTC, seuil 0.15%) ->
# effectiveMaxScore correspond maintenant exactement au maxScore reel du
# dashboard, plus de facteur manquant assume neutre.
# ===================================================================

function Get-EMA {
    param(
        [double[]]$Values,
        [int]$Period
    )
    # object[] plutôt que 'double?[]' : le type générique nullable ne se résout
    # pas via New-Object sous Windows PowerShell 5.1 ("Constructeur introuvable").
    # object[] gère nativement $null et fonctionne identiquement en PS 5.1 et 7+.
    $result = New-Object 'object[]' $Values.Count
    if ($Values.Count -lt $Period) { return $result }

    $multiplier = 2.0 / ($Period + 1)
    $sum = 0.0
    for ($i = 0; $i -lt $Period; $i++) { $sum += $Values[$i] }
    $ema = $sum / $Period
    $result[$Period - 1] = $ema

    for ($i = $Period; $i -lt $Values.Count; $i++) {
        $ema = (($Values[$i] - $ema) * $multiplier) + $ema
        $result[$i] = $ema
    }
    return $result
}

# Tendance stabilisee (confirmation sur N bougies + zone tampon), en excluant
# systematiquement la DERNIERE bougie (generalement en formation, non cloturee
# chez Yahoo) pour eviter le repaint / les faux signaux Telegram en cours de bougie.
function Get-StableTrend {
    param(
        [double[]]$Values,
        [int]$ConfirmCandles = 2,
        [double]$BufferPct = 0.03,
        [bool]$DropLastCandle = $true
    )
    $series = $Values
    if ($DropLastCandle -and $series.Count -gt 1) {
        $series = $series[0..($series.Count - 2)]
    }
    if ($series.Count -lt (50 + $ConfirmCandles)) { return 'neutral' }

    $ema9 = Get-EMA -Values $series -Period 9
    $ema50 = Get-EMA -Values $series -Period 50

    $allBullish = $true
    $allBearish = $true
    for ($i = $series.Count - $ConfirmCandles; $i -lt $series.Count; $i++) {
        $v = $series[$i]
        $e9 = $ema9[$i]
        $e50 = $ema50[$i]
        if ($null -eq $e9 -or $null -eq $e50) { $allBullish = $false; $allBearish = $false; break }
        $bufferAbs = [Math]::Abs($e50) * ($BufferPct / 100)
        $bullish = ($e9 -gt $e50) -and ($v -gt ($e50 + $bufferAbs))
        $bearish = ($e9 -lt $e50) -and ($v -lt ($e50 - $bufferAbs))
        if (-not $bullish) { $allBullish = $false }
        if (-not $bearish) { $allBearish = $false }
    }

    if ($allBullish) { return 'bullish' }
    if ($allBearish) { return 'bearish' }
    return 'neutral'
}

function Get-ScoringConfig {
    param([string]$ScriptRoot)
    $path = Join-Path $ScriptRoot "scoring-config.json"
    if (Test-Path $path) {
        try { return Get-Content -Raw $path | ConvertFrom-Json } catch {}
    }
    # Fallback en dur si le fichier est illisible : DOIT rester identique
    # aux valeurs par defaut de scoring-config.json / FALLBACK_SCORING_CONFIG (app.js).
    return [PSCustomObject]@{
        weights = [PSCustomObject]@{
            macroRegime = 1.5; priceActionM15 = 2.5; crossAssetConfirm = 1
            liquidityIntraday = 1; dailyRsi = 0.5; debasementTrade = 0.5; cotContrarian = 1
        }
        maxScore = 8
        thresholds = [PSCustomObject]@{ strongEdgeFraction = 0.5; moderateEdgeFraction = 0.25 }
        m15Trend = [PSCustomObject]@{ confirmCandles = 2; bufferPct = 0.03; dropLastCandle = $true }
        cot = [PSCustomObject]@{ lookbackWeeks = 26; extremeZ = 1.5 }
    }
}

function Get-SimplifiedEdgeScore {
    param(
        $DailyGold, $DailyDxy, $DailyOil, $DailyXlp, $DailyXly,
        $RealYields, $YieldCurve, $BreakevenInflation,
        $M15Gold, $M15Jpy, $M15Us10y,
        $H4Gold,
        $Cot,
        [string]$ScriptRoot = $PSScriptRoot
    )

    $cfg = Get-ScoringConfig -ScriptRoot $ScriptRoot
    $W = $cfg.weights

    # --- 1. Biais macro (poids W.macroRegime) ---
    # Miroir EXACT de evaluateMacroChecklist() dans app.js : 5 sous-facteurs
    # (real yield, DXY, yield curve, ratio Gold/Oil percentile, XLP/XLY),
    # fenetre de 10 jours (pas 12 - ecart corrige ici), pour eviter toute
    # divergence de Biais Macro entre le dashboard et Telegram.
    $ryByDate = @{}
    foreach ($o in $RealYields) { $ryByDate[$o.date] = $o.value }
    $ycByDate = @{}
    foreach ($o in $YieldCurve) { $ycByDate[$o.date] = $o.value }

    $recentGold = $DailyGold | Sort-Object time | Select-Object -Last 10
    $recentDxy  = $DailyDxy  | Sort-Object time | Select-Object -Last 10
    $recentXlp  = $DailyXlp  | Sort-Object time | Select-Object -Last 10
    $recentXly  = $DailyXly  | Sort-Object time | Select-Object -Last 10

    $favorable = 0
    $unfavorable = 0
    $totalChecks = 0

    # Real Yield : TOUJOURS compte dans le denominateur (comme app.js qui
    # pousse systematiquement { state: ryState } dans le checklist, meme si
    # l'historique est insuffisant - auquel cas ryState reste 'neutral' et
    # ne compte ni favorable ni defavorable, mais compte bien dans le total).
    $totalChecks++
    $ryValues = $recentGold | ForEach-Object {
        $dateStr = ([DateTimeOffset]::FromUnixTimeSeconds([long]$_.time)).UtcDateTime.ToString('yyyy-MM-dd')
        $ryByDate[$dateStr]
    } | Where-Object { $_ -ne $null }
    if ($ryValues.Count -ge 3) {
        $current = $ryValues[-1]
        $avg = ($ryValues[0..($ryValues.Count - 2)] | Measure-Object -Average).Average
        if ($current -le ($avg - 0.05)) { $favorable++ }
        elseif ($current -ge ($avg + 0.05)) { $unfavorable++ }
    }

    # DXY : idem, toujours compte dans le denominateur.
    $totalChecks++
    if ($recentDxy.Count -ge 5) {
        $dxyVals = $recentDxy | ForEach-Object { $_.close }
        $sma = ($dxyVals | Measure-Object -Average).Average
        if ($recentDxy[-1].close -lt $sma) { $favorable++ } else { $unfavorable++ }
    }

    $ycValues = $recentGold | ForEach-Object {
        $dateStr = ([DateTimeOffset]::FromUnixTimeSeconds([long]$_.time)).UtcDateTime.ToString('yyyy-MM-dd')
        $ycByDate[$dateStr]
    } | Where-Object { $_ -ne $null }
    if ($ycValues.Count -ge 1) {
        $totalChecks++
        if ($ycValues[-1] -lt 0) { $favorable++ } else { $unfavorable++ }
    }

    # Ratio Gold/Oil (percentile sur TOUT l'historique dispo, pas juste 10j -
    # identique a app.js qui utilise dailyData en entier ici, pas prevDays).
    # C'etait le facteur manquant : absent de ce moteur jusqu'a maintenant,
    # il expliquait a lui seul l'essentiel de l'ecart de Biais Macro observe
    # entre le dashboard et Telegram le 04/08.
    $oilByDate = @{}
    foreach ($o in ($DailyOil | Sort-Object time)) {
        $dateStr = ([DateTimeOffset]::FromUnixTimeSeconds([long]$o.time)).UtcDateTime.ToString('yyyy-MM-dd')
        $oilByDate[$dateStr] = $o.close
    }
    $allGoldSorted = $DailyGold | Sort-Object time
    $goldOilRatios = @()
    $currentGoldOilRatio = $null
    foreach ($g in $allGoldSorted) {
        $dateStr = ([DateTimeOffset]::FromUnixTimeSeconds([long]$g.time)).UtcDateTime.ToString('yyyy-MM-dd')
        if ($oilByDate.ContainsKey($dateStr) -and $oilByDate[$dateStr] -ne 0) {
            $ratio = $g.close / $oilByDate[$dateStr]
            $goldOilRatios += $ratio
            if ($dateStr -eq (([DateTimeOffset]::FromUnixTimeSeconds([long]$allGoldSorted[-1].time)).UtcDateTime.ToString('yyyy-MM-dd'))) {
                $currentGoldOilRatio = $ratio
            }
        }
    }
    if ($goldOilRatios.Count -gt 50 -and $currentGoldOilRatio) {
        $totalChecks++
        $sortedRatios = $goldOilRatios | Sort-Object
        $rank = [array]::IndexOf($sortedRatios, $currentGoldOilRatio)
        $pct = ($rank / $sortedRatios.Count) * 100
        if ($pct -lt 30) { $favorable++ }
        elseif ($pct -gt 70) { $unfavorable++ }
        # entre 30 et 70 : neutre, ne compte ni favorable ni defavorable
        # (mais totalChecks a deja ete incremente, comme cote app.js)
    }

    # XLP/XLY : toujours compte dans le denominateur (idem app.js).
    $totalChecks++
    if ($recentXlp.Count -ge 5 -and $recentXly.Count -ge 5) {
        $ratios = @()
        for ($i = 0; $i -lt [Math]::Min($recentXlp.Count, $recentXly.Count); $i++) {
            if ($recentXly[$i].close -ne 0) { $ratios += ($recentXlp[$i].close / $recentXly[$i].close) }
        }
        if ($ratios.Count -ge 5) {
            $ratioAvg = ($ratios | Measure-Object -Average).Average
            if ($ratios[-1] -gt $ratioAvg) { $favorable++ } else { $unfavorable++ }
        }
    }

    $macroScore = 0
    if ($totalChecks -gt 0) { $macroScore = (($favorable - $unfavorable) / $totalChecks) * 100 }
    $macroContribution = ($macroScore / 100) * $W.macroRegime

    # --- 2. Momentum M15 de l'or (poids W.priceActionM15), bougies cloturees uniquement ---
    $dropLast = if ($null -ne $cfg.m15Trend.dropLastCandle) { [bool]$cfg.m15Trend.dropLastCandle } else { $true }
    $confirmCandles = if ($cfg.m15Trend.confirmCandles) { [int]$cfg.m15Trend.confirmCandles } else { 2 }
    $bufferPct = if ($cfg.m15Trend.bufferPct) { [double]$cfg.m15Trend.bufferPct } else { 0.03 }

    $goldCloses = $M15Gold | Sort-Object time | ForEach-Object { $_.close }
    $goldTrend = Get-StableTrend -Values $goldCloses -ConfirmCandles $confirmCandles -BufferPct $bufferPct -DropLastCandle $dropLast

    # --- Filtre de confirmation H4 (backtest : M15 seul t-stat=-0.24 non
    # significatif sur 4.2 ans / 100k+ bougies M15 reelles ; M15+H4 t-stat=3.35
    # significatif -> le Momentum M15 ne compte a plein poids QUE si le H4 est
    # d'accord sur le sens, sinon 0 (comme si M15 etait neutre). H4Gold est deja
    # purge de sa derniere bougie si incomplete (fait cote fetch), donc
    # DropLastCandle=$false ici.
    $h4Trend = 'neutral'
    if ($H4Gold -and $H4Gold.Count -gt 0) {
        $h4Closes = $H4Gold | Sort-Object time | ForEach-Object { $_.close }
        $h4Trend = Get-StableTrend -Values $h4Closes -ConfirmCandles $confirmCandles -BufferPct $bufferPct -DropLastCandle $false
    }

    $momentumContribution = 0
    if ($goldTrend -eq 'bullish' -and $h4Trend -eq 'bullish') { $momentumContribution = $W.priceActionM15 }
    elseif ($goldTrend -eq 'bearish' -and $h4Trend -eq 'bearish') { $momentumContribution = -1 * $W.priceActionM15 }

    # --- 3. Confirmation cross-asset FUSIONNEE JPY + US10Y (poids W.crossAssetConfirm TOTAL) ---
    # Meme logique que app.js : accord des deux = poids plein, un seul dispo = poids demi,
    # desaccord = neutre. JPY et US10Y ne sont plus comptes separement (double-comptage
    # du meme facteur taux/dollar deja present dans le biais macro).
    $jpyCloses = $M15Jpy | Sort-Object time | ForEach-Object { $_.close }
    $jpyTrend = Get-StableTrend -Values $jpyCloses -ConfirmCandles $confirmCandles -BufferPct $bufferPct -DropLastCandle $dropLast
    $us10yCloses = $M15Us10y | Sort-Object time | ForEach-Object { $_.close }
    $us10yTrend = Get-StableTrend -Values $us10yCloses -ConfirmCandles $confirmCandles -BufferPct $bufferPct -DropLastCandle $dropLast

    $jpySignal = if ($jpyTrend -eq 'bearish') { 1 } elseif ($jpyTrend -eq 'bullish') { -1 } else { 0 }
    $us10ySignal = if ($us10yTrend -eq 'bearish') { 1 } elseif ($us10yTrend -eq 'bullish') { -1 } else { 0 }

    $crossAssetContribution = 0
    if ($jpySignal -ne 0 -and $us10ySignal -ne 0) {
        if ($jpySignal -eq $us10ySignal) { $crossAssetContribution = $jpySignal * $W.crossAssetConfirm }
    } elseif ($jpySignal -ne 0 -or $us10ySignal -ne 0) {
        $s = if ($jpySignal -ne 0) { $jpySignal } else { $us10ySignal }
        $crossAssetContribution = $s * $W.crossAssetConfirm * 0.5
    }

    # --- 4. COT Managed Money contrarian (poids W.cotContrarian) ---
    $cotContribution = 0
    $cotNetZ = $null
    if ($Cot -and $null -ne $Cot.netZ) {
        $cotNetZ = [double]$Cot.netZ
        $extremeZ = if ($cfg.cot.extremeZ) { [double]$cfg.cot.extremeZ } else { 1.5 }
        if ($cotNetZ -ge $extremeZ) {
            $cotContribution = -1 * $W.cotContrarian * [Math]::Min(1, (($cotNetZ - $extremeZ) / 1) + 0.5)
        } elseif ($cotNetZ -le (-1 * $extremeZ)) {
            $cotContribution = $W.cotContrarian * [Math]::Min(1, ((-1 * $cotNetZ - $extremeZ) / 1) + 0.5)
        }
    }

    # --- 5. RSI Daily (poids W.dailyRsi) + Debasement trade (poids W.debasementTrade) ---
    $dailyRsiContribution = 0
    $dailySorted = $DailyGold | Sort-Object time
    if ($dailySorted.Count -ge 15) {
        $closes = $dailySorted | ForEach-Object { $_.close }
        $period = 14
        $gains = 0.0; $losses = 0.0
        for ($i = 1; $i -le $period; $i++) {
            $diff = $closes[$i] - $closes[$i - 1]
            if ($diff -ge 0) { $gains += $diff } else { $losses -= $diff }
        }
        $avgGain = $gains / $period
        $avgLoss = $losses / $period
        for ($i = $period + 1; $i -lt $closes.Count; $i++) {
            $diff = $closes[$i] - $closes[$i - 1]
            $gain = if ($diff -gt 0) { $diff } else { 0 }
            $loss = if ($diff -lt 0) { -1 * $diff } else { 0 }
            $avgGain = (($avgGain * ($period - 1)) + $gain) / $period
            $avgLoss = (($avgLoss * ($period - 1)) + $loss) / $period
        }
        $rsiDaily = if ($avgLoss -eq 0) { 100 } else { 100 - (100 / (1 + ($avgGain / $avgLoss))) }
        $dailyRsiContribution = ((50 - $rsiDaily) / 50) * $W.dailyRsi
    }

    $debasementContribution = 0
    if ($BreakevenInflation -and $BreakevenInflation.Count -ge 10) {
        $beSorted = $BreakevenInflation | Sort-Object date
        $last10 = $beSorted | Select-Object -Last 10
        $beVals = $last10 | ForEach-Object { $_.value }
        if ($beVals.Count -ge 5) {
            $beAvg = ($beVals[0..($beVals.Count - 2)] | Measure-Object -Average).Average
            $beDelta = $beVals[-1] - $beAvg
            if ($beDelta -ge 0.03) { $debasementContribution = $W.debasementTrade }
            elseif ($beDelta -le -0.03) { $debasementContribution = -1 * $W.debasementTrade }
        }
    }

    # --- Liquidite Intraday (poids W.liquidityIntraday) ---
    # Port exact de la logique du dashboard (app.js) : PDH/PDL = high/low de la
    # bougie QUOTIDIENNE de la veille ; Asia High/Low = high/low des bougies M15
    # d'"aujourd'hui" (date de la DERNIERE bougie M15 dispo, pas l'horloge
    # systeme) entre 00h et 08h UTC. Zone de proximite : 0.15%, identique au JS.
    # Corrige le 07/08/2026 : avant, ce facteur etait absent cote Telegram alors
    # que present cote dashboard -> pouvait faire declencher une alerte SELL/BUY
    # sur PS1 alors que le dashboard, avec ce point de plus, restait neutre
    # (et inversement) -> deux moteurs qui divergent au meme instant.
    $liquidityContribution = 0
    $nearSupport = $false
    $nearResistance = $false
    $sortedM15GoldForLiquidity = $M15Gold | Sort-Object time
    $sortedDailyGoldForLiquidity = $DailyGold | Sort-Object time
    if ($sortedM15GoldForLiquidity.Count -gt 0) {
        $curM15ForLiquidity = $sortedM15GoldForLiquidity[-1]
        $todayDate = ([DateTimeOffset]::FromUnixTimeSeconds([long]$curM15ForLiquidity.time).UtcDateTime).Date

        $yesterdayCandle = if ($sortedDailyGoldForLiquidity.Count -ge 2) { $sortedDailyGoldForLiquidity[-2] } else { $null }
        $pdh = if ($yesterdayCandle) { [double]$yesterdayCandle.high } else { [double]$curM15ForLiquidity.close }
        $pdl = if ($yesterdayCandle) { [double]$yesterdayCandle.low } else { [double]$curM15ForLiquidity.close }

        $todayCandles = @($sortedM15GoldForLiquidity | Where-Object {
            ([DateTimeOffset]::FromUnixTimeSeconds([long]$_.time).UtcDateTime).Date -eq $todayDate
        })
        $todayHigh = if ($todayCandles.Count -gt 0) { ($todayCandles | Measure-Object -Property high -Maximum).Maximum } else { [double]$curM15ForLiquidity.high }
        $todayLow  = if ($todayCandles.Count -gt 0) { ($todayCandles | Measure-Object -Property low -Minimum).Minimum } else { [double]$curM15ForLiquidity.low }

        $asiaCandles = @($todayCandles | Where-Object {
            $h = ([DateTimeOffset]::FromUnixTimeSeconds([long]$_.time).UtcDateTime).Hour
            $h -ge 0 -and $h -lt 8
        })
        $asiaHigh = if ($asiaCandles.Count -gt 0) { ($asiaCandles | Measure-Object -Property high -Maximum).Maximum } else { $todayHigh }
        $asiaLow  = if ($asiaCandles.Count -gt 0) { ($asiaCandles | Measure-Object -Property low -Minimum).Minimum } else { $todayLow }

        $closeForLiquidity = [double]$curM15ForLiquidity.close
        $distToAsiaLow  = (($closeForLiquidity - $asiaLow) / $asiaLow) * 100
        $distToPdl      = (($closeForLiquidity - $pdl) / $pdl) * 100
        $distToAsiaHigh = (($asiaHigh - $closeForLiquidity) / $asiaHigh) * 100
        $distToPdh      = (($pdh - $closeForLiquidity) / $pdh) * 100

        $nearSupport = ([Math]::Abs($distToAsiaLow) -lt 0.15) -or ([Math]::Abs($distToPdl) -lt 0.15)
        $nearResistance = ([Math]::Abs($distToAsiaHigh) -lt 0.15) -or ([Math]::Abs($distToPdh) -lt 0.15)

        if ($nearSupport -and -not $nearResistance) { $liquidityContribution = $W.liquidityIntraday }
        elseif ($nearResistance -and -not $nearSupport) { $liquidityContribution = -1 * $W.liquidityIntraday }
    }

    # $effectiveMaxScore = total des poids reellement calcules ici. Desormais
    # identique au maxScore reel du dashboard (Liquidite Intraday incluse).
    $effectiveMaxScore = $W.macroRegime + $W.priceActionM15 + $W.crossAssetConfirm + $W.liquidityIntraday + $W.dailyRsi + $W.debasementTrade + $W.cotContrarian

    $totalScore = $macroContribution + $momentumContribution + $crossAssetContribution + $liquidityContribution + $dailyRsiContribution + $debasementContribution + $cotContribution

    $realMaxScore = if ($cfg.maxScore) { [double]$cfg.maxScore } else { 9.0 }
    $strongCut   = $realMaxScore * $cfg.thresholds.strongEdgeFraction
    $moderateCut = $realMaxScore * $cfg.thresholds.moderateEdgeFraction

    # verdict : direction pure (buy/sell/wait), independante de la force,
    # pour rester compatible avec le code existant qui la consomme.
    $verdict = 'wait'
    if ($totalScore -ge $moderateCut) { $verdict = 'buy' }
    elseif ($totalScore -le (-1 * $moderateCut)) { $verdict = 'sell' }

    # strength : 'strong' / 'moderate' / 'weak', miroir des labels du
    # dashboard ("Edge Fort" / "Edge Modéré"). 'weak' = sous le seuil
    # Modéré, jamais notifiable.
    $strength = 'weak'
    $absScore = [Math]::Abs($totalScore)
    if ($absScore -ge $strongCut) { $strength = 'strong' }
    elseif ($absScore -ge $moderateCut) { $strength = 'moderate' }

    return [PSCustomObject]@{
        verdict      = $verdict
        strength     = $strength
        score        = [Math]::Round($totalScore, 2)
        maxScore     = [Math]::Round($effectiveMaxScore, 2)
        moderateCut  = [Math]::Round($moderateCut, 3)
        strongCut    = [Math]::Round($strongCut, 3)
        macroScore   = [Math]::Round($macroScore, 0)
        goldTrend    = $goldTrend
        h4Trend      = $h4Trend
        nearSupport    = $nearSupport
        nearResistance = $nearResistance
        jpyTrend     = $jpyTrend
        us10yTrend   = $us10yTrend
        cotNetZ      = $cotNetZ
    }
}
