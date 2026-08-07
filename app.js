// ==========================================
// GESTION DE LA FRAÎCHEUR DES DONNÉES ET RAFRAÎCHISSEMENT RÉEL
// ==========================================
// Le dashboard est servi par Server.ps1 (voir Lancer-Gold-Edge.bat), qui
// écoute aussi les requêtes POST /refresh envoyées par le bouton
// "Actualiser". Quand on clique, le navigateur demande au serveur local
// de relancer Update-Data.ps1 (récupération FRED + Yahoo Finance), puis
// recharge la page une fois que les nouvelles données sont écrites.
const DATA_STALE_THRESHOLD_MINUTES = 20;

function checkDataFreshness(updatedAtStr) {
    const indicator = document.querySelector('.pulse-indicator');
    if (!updatedAtStr) return;

    // Format attendu : "YYYY-MM-DD HH:mm:ss" (heure locale, généré par PowerShell)
    const parsed = updatedAtStr.replace(' ', 'T');
    const updatedDate = new Date(parsed);
    if (isNaN(updatedDate.getTime())) return;

    const ageMinutes = (Date.now() - updatedDate.getTime()) / 60000;

    if (indicator) {
        if (ageMinutes > DATA_STALE_THRESHOLD_MINUTES) {
            indicator.style.backgroundColor = 'var(--color-orange)';
            indicator.title = `Données vieilles de ${Math.round(ageMinutes)} min — cliquez sur Actualiser`;
        } else {
            indicator.style.backgroundColor = 'var(--color-green)';
            indicator.title = 'Données récentes';
        }
    }
}

async function handleRefreshClick() {
    const btn = document.querySelector('.btn-refresh');
    if (!btn || btn.disabled) return;

    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = '<i data-lucide="loader-2"></i> Actualisation...';
    if (typeof lucide !== 'undefined') lucide.createIcons();

    try {
        const res = await fetch('/refresh', { method: 'POST' });
        if (!res.ok) {
            throw new Error(`Le serveur local a renvoyé une erreur (${res.status}).`);
        }
        // Succès : les données ont vraiment été rafraîchies, on recharge la page.
        location.reload();
    } catch (err) {
        // Le plus souvent : la fenêtre "Serveur" a été fermée, ou le dashboard
        // a été ouvert en double-cliquant directement sur index.html (sans
        // passer par Lancer-Gold-Edge.bat), donc /refresh n'existe pas.
        alert(
            "Impossible de contacter le serveur local de mise à jour.\n\n" +
            "Vérifiez que la fenêtre noire \"Gold Edge Analytics - Serveur local actif\" " +
            "est toujours ouverte en arrière-plan.\n\n" +
            "Si elle est fermée, ou si vous avez ouvert ce fichier directement, " +
            "relancez Lancer-Gold-Edge.bat."
        );
        btn.disabled = false;
        btn.classList.remove('is-loading');
        btn.innerHTML = originalHTML;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

// Fallback en dur si scoring-config.json est illisible (ex: dashboard ouvert
// en double-clic direct, sans passer par le serveur local -> fetch() échoue
// en file://). Garanti IDENTIQUE aux valeurs par défaut du fichier JSON au
// moment de cette version, mais le fichier JSON reste la source de vérité
// pour Edge-Score.ps1 (Telegram) et pour toute future modification des poids.
const FALLBACK_SCORING_CONFIG = {
    weights: { macroRegime: 1.5, priceActionM15: 2.5, crossAssetConfirm: 1, liquidityIntraday: 1, dailyRsi: 0.5, debasementTrade: 0.5, cotContrarian: 1 },
    maxScore: 8,
    thresholds: { strongEdgeFraction: 0.5, moderateEdgeFraction: 0.25 },
    m15Trend: { confirmCandles: 2, bufferPct: 0.03, dropLastCandle: true },
    cot: { lookbackWeeks: 26, extremeZ: 1.5 },
    dataHealth: { criticalSeries: ["dailyGold", "m15Gold", "realYields", "dxy"], staleAfterHoursBySeries: { dailyGold: 48, m15Gold: 50, dxy: 48, realYields: 120 }, staleAfterHours: 30 }
};

async function loadScoringConfig() {
    try {
        const res = await fetch('scoring-config.json', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const cfg = await res.json();
        window.SCORING_CONFIG = cfg;
    } catch (e) {
        console.warn('scoring-config.json illisible, utilisation du fallback en dur (poids identiques par défaut).', e);
        window.SCORING_CONFIG = FALLBACK_SCORING_CONFIG;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialiser Lucide Icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // 1bis. RECHARGEMENT AUTOMATIQUE DE LA PAGE : la tâche planifiée réécrit
    // data.js sur le disque toutes les 15 min, mais un onglet déjà ouvert ne
    // le sait pas tant qu'il n'est pas rechargé — <script src="data.js"> n'est
    // lu qu'une fois, au chargement initial. Sans ceci, le dashboard reste
    // figé indéfiniment même si les données et les notifs Telegram, elles,
    // continuent d'avancer en arrière-plan. On recharge toutes les 3 minutes :
    // assez souvent pour rester à jour, assez espacé pour ne pas interrompre
    // une lecture en cours plus que nécessaire.
    const AUTO_RELOAD_MINUTES = 3;
    setTimeout(() => { window.location.reload(); }, AUTO_RELOAD_MINUTES * 60 * 1000);

    // Compte à rebours visuel, pour confirmer que la page n'est pas figée
    // même entre deux rechargements.
    (function startAutoReloadCountdown() {
        const el = document.getElementById('auto-reload-indicator');
        if (!el) return;
        let remaining = AUTO_RELOAD_MINUTES * 60;
        const tick = () => {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            el.innerText = `(rechargement auto dans ${m}:${s.toString().padStart(2, '0')})`;
            remaining--;
            if (remaining < 0) return;
            setTimeout(tick, 1000);
        };
        tick();
    })();

    // 2. Vérifier la présence des données
    if (typeof window.MARKET_DATA === 'undefined') {
        showNoDataOverlay();
        return;
    }

    // 3. Charger la config de scoring partagée AVANT tout calcul de verdict
    await loadScoringConfig();

    try {
        // 4. Charger et traiter les données
        const rawData = window.MARKET_DATA;
        document.getElementById('update-time').innerText = rawData.updatedAt || 'Inconnue';
        window.__goldEdgeDataUpdatedAt = rawData.updatedAt || null;
        checkDataFreshness(rawData.updatedAt);

        const processed = processMarketData(rawData);
        if (!processed || processed.dailyAligned.length === 0 || processed.m15Aligned.length === 0) {
            showErrorState("Données intraday ou quotidiennes incomplètes.");
            return;
        }

        // 5. Mettre à jour l'interface utilisateur
        updateDashboardUI(processed);

        // 6. Initialiser les graphiques
        initCharts(processed);

        // 7. Rafraîchir le panneau Journal & Stats (trades clôturés)
        if (typeof renderJournalStats === 'function') renderJournalStats();
    } catch (err) {
        // Filet de sécurité : si un bug survient, on l'affiche clairement
        // au lieu de laisser la page blanche sans explication.
        console.error('Erreur Gold Edge Analytics :', err);
        showErrorState(`Une erreur inattendue est survenue : ${err.message}`);
    }
});

// Affiche un calque d'erreur si data.js est manquant
function showNoDataOverlay() {
    const container = document.querySelector('.app-container');
    container.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; text-align: center; gap: 24px; padding: 40px;">
            <div style="width: 80px; height: 80px; border-radius: 50%; background-color: var(--color-orange-glow); color: var(--color-orange); display: flex; align-items: center; justify-content: center;">
                <i data-lucide="database-backup" style="width: 48px; height: 48px;"></i>
            </div>
            <h1 style="font-family: var(--font-heading); font-size: 32px; font-weight: 800;">Données manquantes</h1>
            <p style="color: var(--text-secondary); max-width: 500px; font-size: 16px;">
                Le fichier de données local <strong>data.js</strong> n'a pas encore été généré ou est introuvable.
            </p>
            <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); padding: 20px; border-radius: 12px; max-width: 600px; text-align: left;">
                <h3 style="font-family: var(--font-heading); margin-bottom: 8px; color: var(--text-primary);">Comment lancer l'application ?</h3>
                <ol style="margin-left: 20px; color: var(--text-secondary); line-height: 1.8;">
                    <li>Double-cliquez sur le fichier <strong>Lancer-Gold-Edge.bat</strong> situé dans le dossier du projet.</li>
                    <li>Ce fichier va exécuter le script PowerShell qui téléchargera les données réelles et créera <strong>data.js</strong>.</li>
                    <li>La page s'actualisera alors automatiquement.</li>
                </ol>
            </div>
            <button onclick="location.reload();" class="btn-refresh" style="padding: 12px 24px; font-size: 15px;">
                <i data-lucide="refresh-cw"></i> Réessayer
            </button>
        </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function showErrorState(msg) {
    alert("Erreur : " + msg);
}

// Bandeau explicite "DONNÉES INDISPONIBLES" — jamais confondu avec un signal
// de marché neutre. S'affiche/se cache selon dataHealth calculé dans processMarketData.
function renderDataHealthBanner(dataHealth) {
    const el = document.getElementById('data-health-banner');
    if (!el) return;
    if (!dataHealth || dataHealth.ok) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'flex';
    el.innerHTML = `<i data-lucide="alert-octagon"></i> <span>DONNÉES INDISPONIBLES : ${dataHealth.failingSeries.join(', ')} — le verdict "Mon Edge" est bloqué en ATTENDRE tant que ces flux ne sont pas rétablis. Ceci n'est pas un signal de marché.</span>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Helpers dates
function timeToDateString(t) {
    const d = new Date(t * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Process data
function processMarketData(rawData) {
    // --- 1. TRAITEMENT DES SÉRIES DAILY (Macro) ---
    const dates = {};
    const gold = rawData.dailyData.Gold || [];
    const dxy = rawData.dailyData.DXY || [];
    const oil = rawData.dailyData.Oil || [];
    const vix = rawData.dailyData.VIX || [];
    const xlp = rawData.dailyData.XLP || [];
    const xly = rawData.dailyData.XLY || [];
    const realYields = rawData.realYields || [];
    const yieldCurve = rawData.yieldCurve || [];
    const breakevenInflation = rawData.breakevenInflation || [];

    gold.forEach(c => {
        const dStr = timeToDateString(c.time);
        if (!dates[dStr]) dates[dStr] = {};
        dates[dStr].gold = c.close;
        dates[dStr].goldOpen = c.open;
        dates[dStr].goldHigh = c.high;
        dates[dStr].goldLow = c.low;
        dates[dStr].goldTime = c.time;
    });
    dxy.forEach(c => {
        const dStr = timeToDateString(c.time);
        if (!dates[dStr]) dates[dStr] = {};
        dates[dStr].dxy = c.close;
    });
    oil.forEach(c => {
        const dStr = timeToDateString(c.time);
        if (!dates[dStr]) dates[dStr] = {};
        dates[dStr].oil = c.close;
    });
    vix.forEach(c => {
        const dStr = timeToDateString(c.time);
        if (!dates[dStr]) dates[dStr] = {};
        dates[dStr].vix = c.close;
    });
    xlp.forEach(c => {
        const dStr = timeToDateString(c.time);
        if (!dates[dStr]) dates[dStr] = {};
        dates[dStr].xlp = c.close;
    });
    xly.forEach(c => {
        const dStr = timeToDateString(c.time);
        if (!dates[dStr]) dates[dStr] = {};
        dates[dStr].xly = c.close;
    });
    realYields.forEach(o => {
        if (!dates[o.date]) dates[o.date] = {};
        dates[o.date].realYield = o.value;
    });
    yieldCurve.forEach(o => {
        if (!dates[o.date]) dates[o.date] = {};
        dates[o.date].yieldCurve = o.value;
    });
    breakevenInflation.forEach(o => {
        if (!dates[o.date]) dates[o.date] = {};
        dates[o.date].breakeven = o.value;
    });

    const sortedDates = Object.keys(dates).sort();
    let lastGold = null, lastGoldOpen = null, lastGoldHigh = null, lastGoldLow = null, lastGoldTime = null;
    let lastDxy = null, lastOil = null, lastVix = null, lastXlp = null, lastXly = null;
    let lastRealYield = null, lastYieldCurve = null, lastBreakeven = null;

    const dailyAligned = [];

    sortedDates.forEach(dateStr => {
        const day = dates[dateStr];
        if (day.gold !== undefined) {
            lastGold = day.gold;
            lastGoldOpen = day.goldOpen;
            lastGoldHigh = day.goldHigh;
            lastGoldLow = day.goldLow;
            lastGoldTime = day.goldTime;
        }
        if (day.dxy !== undefined) lastDxy = day.dxy;
        if (day.oil !== undefined) lastOil = day.oil;
        if (day.vix !== undefined) lastVix = day.vix;
        if (day.xlp !== undefined) lastXlp = day.xlp;
        if (day.xly !== undefined) lastXly = day.xly;
        if (day.realYield !== undefined) lastRealYield = day.realYield;
        if (day.yieldCurve !== undefined) lastYieldCurve = day.yieldCurve;
        if (day.breakeven !== undefined) lastBreakeven = day.breakeven;

        if (lastGold !== null) {
            dailyAligned.push({
                date: dateStr,
                time: lastGoldTime || (new Date(dateStr).getTime() / 1000),
                open: lastGoldOpen,
                high: lastGoldHigh,
                low: lastGoldLow,
                close: lastGold,
                dxy: lastDxy,
                oil: lastOil,
                vix: lastVix,
                xlp: lastXlp,
                xly: lastXly,
                realYield: lastRealYield,
                yieldCurve: lastYieldCurve,
                breakeven: lastBreakeven,
                goldOilRatio: (lastGold && lastOil) ? (lastGold / lastOil) : null,
                xlpXlyRatio: (lastXlp && lastXly) ? (lastXlp / lastXly) : null
            });
        }
    });

    // Calculer les indicateurs daily
    const dailyCloses = dailyAligned.map(d => d.close);
    const sma200 = calculateSMA(dailyCloses, 200);
    const rsiDaily = calculateRSI(dailyCloses, 14);
    for (let i = 0; i < dailyAligned.length; i++) {
        dailyAligned[i].sma200 = sma200[i];
        dailyAligned[i].rsi14 = rsiDaily[i];
    }

    // --- 2. TRAITEMENT DES SÉRIES M15 (Scalping) ---
    const m15Gold = rawData.m15Data.Gold || [];
    const m15Jpy = rawData.m15Data.JPY || [];
    const m15Us10y = rawData.m15Data.US10Y || [];

    // Aligner par timestamp M15
    const m15Timestamps = {};
    m15Gold.forEach(c => {
        if (!m15Timestamps[c.time]) m15Timestamps[c.time] = {};
        m15Timestamps[c.time].gold = c;
    });
    m15Jpy.forEach(c => {
        if (!m15Timestamps[c.time]) m15Timestamps[c.time] = {};
        m15Timestamps[c.time].jpy = c.close;
    });
    m15Us10y.forEach(c => {
        if (!m15Timestamps[c.time]) m15Timestamps[c.time] = {};
        m15Timestamps[c.time].us10y = c.close;
    });

    const sortedM15Times = Object.keys(m15Timestamps).sort((a,b) => Number(a) - Number(b));
    let lastM15Gold = null, lastM15Jpy = null, lastM15Us10y = null;

    const m15Aligned = [];
    sortedM15Times.forEach(tStr => {
        const t = Number(tStr);
        const item = m15Timestamps[tStr];
        
        if (item.gold !== undefined) lastM15Gold = item.gold;
        if (item.jpy !== undefined) lastM15Jpy = item.jpy;
        if (item.us10y !== undefined) lastM15Us10y = item.us10y;

        if (lastM15Gold !== null) {
            m15Aligned.push({
                time: t,
                open: lastM15Gold.open,
                high: lastM15Gold.high,
                low: lastM15Gold.low,
                close: lastM15Gold.close,
                jpy: lastM15Jpy,
                us10y: lastM15Us10y
            });
        }
    });

    // Calculer les indicateurs M15 (EMA 9, EMA 50, RSI 14)
    const m15Closes = m15Aligned.map(d => d.close);
    const ema9 = calculateEMA(m15Closes, 9);
    const ema50 = calculateEMA(m15Closes, 50);
    const rsi15m = calculateRSI(m15Closes, 14);

    for (let i = 0; i < m15Aligned.length; i++) {
        m15Aligned[i].ema9 = ema9[i];
        m15Aligned[i].ema50 = ema50[i];
        m15Aligned[i].rsi14 = rsi15m[i];
    }

    // --- 3. SANTÉ DES DONNÉES : distingue "pas de données" de "signal neutre" ---
    // Ne jamais laisser un flux Yahoo/FRED cassé se déguiser en "marché neutre".
    const cfg = window.SCORING_CONFIG || FALLBACK_SCORING_CONFIG;
    const nowSec = Date.now() / 1000;
    const dh = cfg.dataHealth || FALLBACK_SCORING_CONFIG.dataHealth;
    const staleThresholdsHours = dh.staleAfterHoursBySeries || {};
    const defaultStaleHours = dh.staleAfterHours ?? 30;
    const staleAfterHoursFor = (key) => staleThresholdsHours[key] ?? defaultStaleHours;

    const lastGoldDailyTime = dailyAligned.length ? dailyAligned[dailyAligned.length - 1].time : null;
    const lastGoldM15Time = m15Aligned.length ? m15Aligned[m15Aligned.length - 1].time : null;
    const lastRealYieldDate = realYields.length
        ? realYields.reduce((max, o) => (!max || o.date > max) ? o.date : max, null)
        : null;
    // Age du DXY calcule sur SON PROPRE dernier horodatage (pas celui de l'or) -
    // sinon un echec de fetch specifique au DXY (Yahoo bloque ce ticker en
    // particulier, par ex.) passe totalement inapercu puisque l'age emprunte
    // etait celui de l'or, qui peut tres bien avoir reussi son propre fetch.
    const lastDxyTime = dxy.length ? dxy.reduce((max, c) => (!max || c.time > max) ? c.time : max, null) : null;
    const lastDxyDaily = dailyAligned.length ? dailyAligned[dailyAligned.length - 1].dxy : null;

    const seriesHealth = {
        dailyGold: { present: dailyAligned.length > 0, ageHours: lastGoldDailyTime ? (nowSec - lastGoldDailyTime) / 3600 : null },
        m15Gold:   { present: m15Aligned.length >= (50 + 3), ageHours: lastGoldM15Time ? (nowSec - lastGoldM15Time) / 3600 : null },
        realYields:{ present: realYields.length > 0, ageHours: lastRealYieldDate ? (nowSec - (new Date(lastRealYieldDate).getTime() / 1000)) / 3600 : null },
        dxy:       { present: lastDxyDaily !== null && lastDxyDaily !== undefined, ageHours: lastDxyTime ? (nowSec - lastDxyTime) / 3600 : null }
    };

    const criticalSeries = cfg.dataHealth?.criticalSeries || FALLBACK_SCORING_CONFIG.dataHealth.criticalSeries;
    const failingSeries = [];
    criticalSeries.forEach(key => {
        const h = seriesHealth[key];
        const thresholdHours = staleAfterHoursFor(key);
        if (!h || !h.present || (h.ageHours !== null && h.ageHours > thresholdHours)) {
            failingSeries.push(key);
        }
    });
    const dataHealth = { ok: failingSeries.length === 0, failingSeries, seriesHealth };

    // --- H4 (filtre de confirmation du Momentum M15, dérivé du M15 Gold
    // étendu côté fetch, déjà purgé de sa bougie incomplète) ---
    const h4Aligned = ((rawData.h4Data && rawData.h4Data.Gold) || []).slice().sort((a, b) => a.time - b.time);

    return {
        dailyAligned: dailyAligned,
        m15Aligned: m15Aligned,
        h4Aligned: h4Aligned,
        dataHealth: dataHealth,
        cot: rawData.cot || null
    };
}

// Calculs mathématiques

// Moyenne Mobile Simple (SMA) — utilisée pour la MM200 quotidienne
function calculateSMA(values, period) {
    const sma = new Array(values.length).fill(null);
    if (values.length < period) return sma;

    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period) {
            sum -= values[i - period];
        }
        if (i >= period - 1) {
            sma[i] = sum / period;
        }
    }
    return sma;
}

// RSI (Relative Strength Index) — méthode de lissage de Wilder, standard sur 14 périodes
function calculateRSI(values, period) {
    const rsi = new Array(values.length).fill(null);
    if (values.length <= period) return rsi;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

    for (let i = period + 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    }
    return rsi;
}

// ATR (Average True Range) — méthode de lissage de Wilder, standard 14 périodes.
// Sert à dimensionner un stop-loss/objectif adaptés à la volatilité RÉELLE de
// l'or, plutôt qu'une distance fixe qui se fait toucher par le bruit M15.
function calculateATR(dailyCandles, period) {
    const atr = new Array(dailyCandles.length).fill(null);
    if (dailyCandles.length <= period) return atr;

    const trueRanges = [null]; // pas de TR pour la toute première bougie (pas de clôture précédente)
    for (let i = 1; i < dailyCandles.length; i++) {
        const cur = dailyCandles[i];
        const prevClose = dailyCandles[i - 1].close;
        const tr = Math.max(
            cur.high - cur.low,
            Math.abs(cur.high - prevClose),
            Math.abs(cur.low - prevClose)
        );
        trueRanges.push(tr);
    }

    let sum = 0;
    for (let i = 1; i <= period; i++) sum += trueRanges[i];
    let avgTR = sum / period;
    atr[period] = avgTR;

    for (let i = period + 1; i < dailyCandles.length; i++) {
        avgTR = (avgTR * (period - 1) + trueRanges[i]) / period;
        atr[i] = avgTR;
    }
    return atr;
}

function calculateEMA(values, period) {
    let ema = new Array(values.length).fill(null);
    if (values.length < period) return ema;

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += values[i];
    }
    let prevEma = sum / period;
    ema[period - 1] = prevEma;

    const multiplier = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
        let curEma = (values[i] - prevEma) * multiplier + prevEma;
        ema[i] = curEma;
        prevEma = curEma;
    }
    return ema;
}

// Met à jour la logique du Dashboard
function updateDashboardUI(processed) {
    const daily = processed.dailyAligned;
    const m15 = processed.m15Aligned;

    const curDaily = daily[daily.length - 1];
    const curM15 = m15[m15.length - 1];

    // --- 1. CALCUL DU BIAIS MACRO GLOBAL (Gauges) ---
    const checklist = evaluateMacroChecklist(daily);
    let fav = 0, unfav = 0;
    checklist.forEach(item => {
        if (item.state === 'favorable') fav++;
        else if (item.state === 'defavorable') unfav++;
    });
    const macroScore = checklist.length > 0 ? ((fav - unfav) / checklist.length) * 100 : 0;
    
    // UI Jauge Macro
    const pctText = document.getElementById('score-percentage');
    const lblText = document.getElementById('score-label');
    const gaugeFill = document.getElementById('gauge-fill');
    
    pctText.innerText = `${macroScore >= 0 ? '+' : ''}${macroScore.toFixed(0)}%`;
    const normalizedScore = (macroScore + 100) / 200;
    gaugeFill.style.strokeDashoffset = 251.2 - (normalizedScore * 251.2);

    let macroDirection = 'neutral';
    if (macroScore >= 25) {
        lblText.innerText = 'BUY ONLY (HAUSSIER)';
        lblText.style.color = 'var(--color-green)';
        gaugeFill.style.stroke = 'var(--color-green)';
        macroDirection = 'bullish';
    } else if (macroScore <= -25) {
        lblText.innerText = 'SHORT ONLY (BAISSIER)';
        lblText.style.color = 'var(--color-red)';
        gaugeFill.style.stroke = 'var(--color-red)';
        macroDirection = 'bearish';
    } else {
        lblText.innerText = 'BI-DIRECTIONNEL';
        lblText.style.color = 'var(--color-orange)';
        gaugeFill.style.stroke = 'var(--color-orange)';
    }

    // --- 2. TRACKER ADR ---
    // Calculer l'ADR (range moyen 10 jours)
    const adrCloses = daily.slice(-10);
    const adrSum = adrCloses.reduce((acc, d) => acc + (d.high - d.low), 0);
    const adr10d = adrSum / adrCloses.length;

    // Calculer le range d'aujourd'hui depuis les bougies M15 d'aujourd'hui
    // On utilise la date de la DERNIÈRE bougie disponible dans les données
    // (et non l'horloge du PC) : si data.js n'a pas été régénéré aujourd'hui,
    // "aujourd'hui" pour le dashboard reste la dernière session réellement
    // couverte par les données, ce qui évite un ADR/High/Low faux ou à $0.
    const todayStr = m15.length > 0 ? timeToDateString(m15[m15.length - 1].time) : new Date().toISOString().split('T')[0];
    const todayCandles = m15.filter(c => timeToDateString(c.time) === todayStr);
    
    let todayHigh = curM15.high;
    let todayLow = curM15.low;
    let todayOpen = curM15.open;

    if (todayCandles.length > 0) {
        todayHigh = Math.max(...todayCandles.map(c => c.high));
        todayLow = Math.min(...todayCandles.map(c => c.low));
        todayOpen = todayCandles[0].open;
    }

    const todayRange = todayHigh - todayLow;
    const adrPct = adr10d > 0 ? (todayRange / adr10d) * 100 : 0;

    document.getElementById('adr-current-range').innerText = `$${todayRange.toFixed(2)}`;
    document.getElementById('adr-10d').innerText = `$${adr10d.toFixed(2)}`;
    document.getElementById('day-high').innerText = `$${todayHigh.toFixed(2)}`;
    document.getElementById('day-low').innerText = `$${todayLow.toFixed(2)}`;
    
    const adrBar = document.getElementById('adr-progress-bar');
    const adrWarning = document.getElementById('adr-exhaustion-warning');
    const adrPercentageText = document.getElementById('adr-percentage');
    const adrBadge = document.getElementById('adr-status-badge');

    adrBar.style.width = `${Math.min(adrPct, 100)}%`;
    adrPercentageText.innerText = `${adrPct.toFixed(0)}% de l'ADR rempli`;

    if (adrPct >= 90) {
        adrWarning.style.display = 'block';
        adrBar.style.background = 'var(--color-red)';
        adrBadge.innerText = 'EXTENSION MAX';
        adrBadge.style.backgroundColor = 'var(--color-red)';
        adrBadge.style.color = '#fff';
    } else {
        adrWarning.style.display = 'none';
        adrBar.style.background = 'linear-gradient(90deg, var(--color-green) 0%, var(--color-orange) 70%, var(--color-red) 100%)';
        adrBadge.innerText = 'VOLATILITÉ OK';
        adrBadge.style.backgroundColor = 'var(--border-color)';
        adrBadge.style.color = 'var(--text-secondary)';
    }

    // --- 3. CARTOGRAPHIE DE LA LIQUIDITÉ (Sessions) ---
    // Previous Day High & Low (PDH & PDL)
    const yesterdayCandle = daily[daily.length - 2];
    const pdh = yesterdayCandle ? yesterdayCandle.high : curM15.close;
    const pdl = yesterdayCandle ? yesterdayCandle.low : curM15.close;

    // Asian Session Levels (00:00 à 08:00 UTC)
    let asiaHigh = -Infinity;
    let asiaLow = Infinity;
    
    m15.forEach(c => {
        const date = new Date(c.time * 1000);
        const dayString = date.toISOString().split('T')[0];
        
        if (dayString === todayStr) {
            const hour = date.getUTCHours();
            if (hour >= 0 && hour < 8) {
                if (c.high > asiaHigh) asiaHigh = c.high;
                if (c.low < asiaLow) asiaLow = c.low;
            }
        }
    });

    // Fallbacks si la session d'Asie n'a pas encore commencé ou s'il n'y a pas de bougies
    if (asiaHigh === -Infinity) asiaHigh = todayHigh;
    if (asiaLow === Infinity) asiaLow = todayLow;

    // Afficher les prix des zones
    document.getElementById('price-pdh').innerText = `$${pdh.toFixed(2)}`;
    document.getElementById('price-asiah').innerText = `$${asiaHigh.toFixed(2)}`;
    document.getElementById('price-do').innerText = `$${todayOpen.toFixed(2)}`;
    document.getElementById('price-asial').innerText = `$${asiaLow.toFixed(2)}`;
    document.getElementById('price-pdl').innerText = `$${pdl.toFixed(2)}`;

    // Calculer les états de proximité
    updateLevelStatus('pdh', curM15.close, pdh, "high");
    updateLevelStatus('asiah', curM15.close, asiaHigh, "high");
    updateLevelStatus('do', curM15.close, todayOpen, "neutral");
    updateLevelStatus('asial', curM15.close, asiaLow, "low");
    updateLevelStatus('pdl', curM15.close, pdl, "low");

    // --- 4. TENDANCES M15 & CORRÉLATIONS ---
    const jpyTrend = getM15Trend(m15, 'jpy');
    const us10yTrend = getM15Trend(m15, 'us10y');
    const goldTrend = getM15Trend(m15, 'close'); // Or M15

    // Filtre de confirmation H4 (backtest sur 4.2 ans / 100k+ bougies M15
    // réelles XM : M15 seul t-stat=-0.24 non significatif, M15+H4 t-stat=3.35
    // significatif). H4 déjà purgé de sa bougie incomplète côté fetch ->
    // dropLastCandle=false explicite (5e argument).
    const h4Trend = getM15Trend(processed.h4Aligned || [], 'close', undefined, undefined, false);

    // Mettre à jour le tableau des tendances
    document.getElementById('trend-jpy').innerHTML = formatTrendCell(jpyTrend);
    document.getElementById('trend-us10y').innerHTML = formatTrendCell(us10yTrend);
    document.getElementById('trend-gold').innerHTML = formatTrendCell(goldTrend);

    // Mettre à jour les badges d'états de corrélation
    updateCorrelationBadge('badge-jpy', jpyTrend, 'bearish'); // Favorable si JPY baisse
    updateCorrelationBadge('badge-us10y', us10yTrend, 'bearish'); // Favorable si Yields baissent
    updateCorrelationBadge('badge-gold', goldTrend, 'bullish'); // Favorable si Or monte

    // --- 5. SIGNAL DE TRADING SCALPING M15 ---
    const signalCard = document.getElementById('signal-card');
    const signalBadge = document.getElementById('signal-badge');
    const signalIcon = document.getElementById('signal-icon-large');
    const signalTitle = document.getElementById('signal-text-summary');
    const signalDesc = document.getElementById('signal-desc-detail');
    const alertListEl = document.getElementById('signal-alerts-list');
    
    alertListEl.innerHTML = '';
    signalCard.className = 'card signal-card';

    // Détecter les croisements d'EMA 9/50 pour l'or (déjà calculés plus haut pour le verdict unifié)

    // Détecter si les corrélations intraday soutiennent le mouvement
    const isJpySupportiveForBuy = jpyTrend === 'bearish';
    const isUs10ySupportiveForBuy = us10yTrend === 'bearish';
    const isJpySupportiveForSell = jpyTrend === 'bullish';
    const isUs10ySupportiveForSell = us10yTrend === 'bullish';

    // Détection des proximités de niveaux
    const distToAsiaLow = ((curM15.close - asiaLow) / asiaLow) * 100;
    const distToPdl = ((curM15.close - pdl) / pdl) * 100;
    const distToAsiaHigh = ((asiaHigh - curM15.close) / asiaHigh) * 100;
    const distToPdh = ((pdh - curM15.close) / pdh) * 100;

    // --- MON EDGE : VERDICT UNIFIÉ (synthèse de tous les facteurs) ---
    // isGoldBullish / isGoldBearish utilisent désormais la même logique stabilisée
    // (confirmation sur plusieurs bougies M15) que goldTrend ci-dessus, pour que
    // le verdict ne change pas à chaque mèche.
    const isGoldBullish = goldTrend === 'bullish';
    const isGoldBearish = goldTrend === 'bearish';
    const verdictResult = computeUnifiedVerdict({
        macroScore,
        curM15,
        curDaily,
        daily,
        jpyTrend,
        us10yTrend,
        isGoldBullish,
        isGoldBearish,
        h4Trend,
        adrPct,
        distToAsiaLow,
        distToPdl,
        distToAsiaHigh,
        distToPdh,
        dataHealth: processed.dataHealth,
        cot: processed.cot
    });
    renderDataHealthBanner(processed.dataHealth);
    renderVerdictUI(verdictResult);
    renderRiskManagement(daily, curM15.close, verdictResult.verdict);

    // Rendus disponibles globalement pour le bouton "Enregistrer ce Trade"
    window.__latestVerdictResult = verdictResult;
    window.__latestPrice = curM15.close;
    renderTradeThesisUI(verdictResult, curM15.close);

    let scalpingSignal = 'wait';
    
    if (macroDirection === 'bullish' && isGoldBullish && (isJpySupportiveForBuy || isUs10ySupportiveForBuy)) {
        // Idéalement acheter sur repli près d'un niveau
        if (Math.abs(distToAsiaLow) < 0.1 || Math.abs(distToPdl) < 0.1 || Math.abs((curM15.close - todayOpen)/todayOpen * 100) < 0.1) {
            scalpingSignal = 'buy';
        } else {
            scalpingSignal = 'buy-setup'; // Tendance haussière mais en attente de repli
        }
    } else if (macroDirection === 'bearish' && isGoldBearish && (isJpySupportiveForSell || isUs10ySupportiveForSell)) {
        if (Math.abs(distToAsiaHigh) < 0.1 || Math.abs(distToPdh) < 0.1) {
            scalpingSignal = 'sell';
        } else {
            scalpingSignal = 'sell-setup';
        }
    }

    // Affichage des signaux
    if (scalpingSignal === 'buy') {
        signalCard.classList.add('bullish');
        signalBadge.innerText = 'BUY TRIGGER';
        signalBadge.style.backgroundColor = 'var(--color-green)';
        signalIcon.innerHTML = '<i data-lucide="zap"></i>';
        signalIcon.style.color = 'var(--color-green)';
        signalTitle.innerText = 'Achat Immédiat (Intraday, hold ≤24h)';
        signalDesc.innerText = 'Biais macro haussier, croisement EMA M15 haussier, et test en cours d\'un support de liquidité majeur.';
    } else if (scalpingSignal === 'buy-setup') {
        signalCard.classList.add('bullish');
        signalBadge.innerText = 'BUY SETUP';
        signalBadge.style.backgroundColor = 'var(--color-orange)';
        signalIcon.innerHTML = '<i data-lucide="trending-up"></i>';
        signalTitle.innerText = 'Tendance Haissière (Attendre Repli)';
        signalDesc.innerText = 'Le flux est haussier. Attendez un test du Daily Open ou de l\'Asia Low en M15 pour acheter.';
    } else if (scalpingSignal === 'sell') {
        signalCard.classList.add('bearish');
        signalBadge.innerText = 'SELL TRIGGER';
        signalBadge.style.backgroundColor = 'var(--color-red)';
        signalIcon.innerHTML = '<i data-lucide="zap"></i>';
        signalIcon.style.color = 'var(--color-red)';
        signalTitle.innerText = 'Vente Immédiate (Intraday, hold ≤24h)';
        signalDesc.innerText = 'Biais macro baissier, croisement EMA M15 baissier, et rejet d\'une résistance de liquidité majeure.';
    } else if (scalpingSignal === 'sell-setup') {
        signalCard.classList.add('bearish');
        signalBadge.innerText = 'SELL SETUP';
        signalBadge.style.backgroundColor = 'var(--color-orange)';
        signalIcon.innerHTML = '<i data-lucide="trending-down"></i>';
        signalTitle.innerText = 'Tendance Baissière (Attendre Hausse)';
        signalDesc.innerText = 'Le flux est baissier. Attendez un retest de l\'Asia High ou du PDH en M15 pour vendre.';
    } else {
        signalBadge.innerText = 'PATIENCE';
        signalIcon.innerHTML = '<i data-lucide="clock"></i>';
        signalTitle.innerText = 'Aucune configuration claire';
        signalDesc.innerText = 'Le biais macro et les tendances de scalping intraday sont conflictuels. Restez en attente.';
    }

    // Affichage des alertes spécifiques
    if (Math.abs(distToPdh) < 0.05) {
        addAlertBadge("Sweep PDH Proche", "bear", "Le cours approche du plus haut de la veille. Risque de fausse cassure.", alertListEl);
    }
    if (Math.abs(distToPdl) < 0.05) {
        addAlertBadge("Sweep PDL Proche", "bull", "Le cours approche du plus bas de la veille. Chasse aux stops possible.", alertListEl);
    }
    if (isJpySupportiveForBuy && isUs10ySupportiveForBuy && !isGoldBullish) {
        addAlertBadge("Divergence Haussière Latente", "bull", "L'USD/JPY et les taux US chutent, l'Or est en retard. Pression d'achat imminente.", alertListEl);
    }
    if (isJpySupportiveForSell && isUs10ySupportiveForSell && !isGoldBearish) {
        addAlertBadge("Divergence Baissière Latente", "bear", "L'USD/JPY et les taux US montent, l'Or est en retard. Risque de décrochage.", alertListEl);
    }
    if (curM15.rsi14 > 70) {
        addAlertBadge("RSI M15 Suracheté", "bear", "RSI M15 supérieur à 70. Éviter d'acheter maintenant.", alertListEl);
    } else if (curM15.rsi14 < 30) {
        addAlertBadge("RSI M15 Survendu", "bull", "RSI M15 inférieur à 30. Zone de rebond court terme.", alertListEl);
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ==========================================
// MON EDGE : VERDICT UNIFIÉ (Synthèse BUY / SELL / ATTENDRE)
// ==========================================
// Combine tous les facteurs macro, techniques et de corrélation en un seul
// verdict clair, avec le détail de ce qui compte pour ou contre.
function computeUnifiedVerdict(ctx) {
    const {
        macroScore, curM15, curDaily, daily, jpyTrend, us10yTrend,
        isGoldBullish, isGoldBearish, h4Trend, adrPct,
        distToAsiaLow, distToPdl, distToAsiaHigh, distToPdh,
        dataHealth, cot
    } = ctx;

    const cfg = window.SCORING_CONFIG || FALLBACK_SCORING_CONFIG;
    const W = cfg.weights;
    const reasons = [];
    let score = 0;

    // --- 0. GARDE-FOU DONNÉES : jamais de verdict sur des données cassées ---
    // Une série critique absente ou périmée n'est PAS un "marché neutre" —
    // c'est une panne de flux. On le dit explicitement plutôt que de laisser
    // le score retomber silencieusement à 0.
    if (dataHealth && !dataHealth.ok) {
        return {
            verdict: 'wait',
            title: 'ATTENDRE — Données Indisponibles',
            subtitle: `Série(s) manquante(s) ou périmée(s) : ${dataHealth.failingSeries.join(', ')}. Le verdict est bloqué tant que ces flux ne sont pas rétablis — ce n'est pas un signal de marché neutre.`,
            score: 0,
            confidence: 0,
            reasons: [{ label: 'Santé des données', detail: dataHealth.failingSeries.join(', '), state: 'unfavorable' }],
            adrPct,
            dataBlocked: true
        };
    }

    // 1. Biais Macro HTF (poids configurable, défaut ±3)
    const macroContribution = (macroScore / 100) * W.macroRegime;
    score += macroContribution;
    reasons.push({
        label: 'Biais Macro (HTF)',
        detail: `${macroScore >= 0 ? '+' : ''}${macroScore.toFixed(0)}%`,
        state: macroScore > 10 ? 'favorable' : (macroScore < -10 ? 'unfavorable' : 'neutral')
    });

    // 2. Momentum M15 (croisement EMA 9/50, bougies clôturées uniquement) : poids configurable, défaut ±2
    // Filtre de confirmation H4 : backtest sur 4.2 ans / 100k+ bougies M15
    // réelles XM -> M15 seul t-stat=-0.24 (non significatif), M15+H4 t-stat=3.35
    // (significatif). Le Momentum M15 ne compte à plein poids QUE si le H4 est
    // d'accord sur le sens ; sinon traité comme neutre (contribution 0).
    if (isGoldBullish && h4Trend === 'bullish') {
        score += W.priceActionM15;
        reasons.push({ label: 'Momentum M15 (EMA 9/50)', detail: 'Haussier (confirmé H4)', state: 'favorable' });
    } else if (isGoldBearish && h4Trend === 'bearish') {
        score -= W.priceActionM15;
        reasons.push({ label: 'Momentum M15 (EMA 9/50)', detail: 'Baissier (confirmé H4)', state: 'unfavorable' });
    } else if (isGoldBullish || isGoldBearish) {
        reasons.push({
            label: 'Momentum M15 (EMA 9/50)',
            detail: `${isGoldBullish ? 'Haussier' : 'Baissier'} mais H4 non confirmé (${h4Trend}) — neutralisé`,
            state: 'neutral'
        });
    } else {
        reasons.push({ label: 'Momentum M15 (EMA 9/50)', detail: 'Neutre / Range', state: 'neutral' });
    }

    // 3. RSI M15 : NE COMPTE PLUS COMME UN POINT SÉPARÉ.
    // RSI M15 et momentum EMA M15 sont deux transformations du MÊME flux de
    // prix M15 — les additionner double-comptait la même information sous
    // deux habillages différents. RSI M15 sert maintenant uniquement de
    // DRAPEAU DE PRUDENCE quand il contredit le momentum (ex: momentum
    // haussier mais RSI déjà suracheté) : affiché, mais n'ajoute aucun point.
    const rsi15 = curM15.rsi14;
    if (rsi15 !== null && rsi15 !== undefined) {
        let rsiState = 'neutral';
        let rsiDetail = rsi15.toFixed(0);
        if (isGoldBullish && rsi15 > 70) { rsiState = 'unfavorable'; rsiDetail += ' (suracheté — momentum tardif)'; }
        else if (isGoldBearish && rsi15 < 30) { rsiState = 'unfavorable'; rsiDetail += ' (survendu — momentum tardif)'; }
        else if (rsi15 > 70 || rsi15 < 30) { rsiState = 'neutral'; rsiDetail += ' (zone extrême)'; }
        reasons.push({ label: 'RSI M15 (info, non pondéré)', detail: rsiDetail, state: rsiState });
    }

    // 4. Confirmation cross-asset FUSIONNÉE (poids configurable, défaut ±1 TOTAL)
    // USD/JPY et US10Y sont tous deux des proxies du même facteur "taux/dollar"
    // déjà présent dans le Biais Macro. Les compter ±1 CHACUN (comme avant)
    // double-comptait ce facteur. On les fusionne en une seule confirmation :
    // accord des deux -> poids plein ; un seul dispo -> poids demi ;
    // contradiction entre les deux -> neutre (le marché intraday hésite).
    let crossAssetScore = 0;
    let crossAssetDetail = 'Neutre';
    let crossAssetState = 'neutral';
    const jpySignal = jpyTrend === 'bearish' ? 1 : (jpyTrend === 'bullish' ? -1 : 0);
    const us10ySignal = us10yTrend === 'bearish' ? 1 : (us10yTrend === 'bullish' ? -1 : 0);
    if (jpySignal !== 0 && us10ySignal !== 0) {
        if (jpySignal === us10ySignal) {
            crossAssetScore = jpySignal * W.crossAssetConfirm;
            crossAssetDetail = jpySignal > 0 ? 'JPY + US10Y baissiers → favorable Or' : 'JPY + US10Y haussiers → défavorable Or';
            crossAssetState = jpySignal > 0 ? 'favorable' : 'unfavorable';
        } else {
            crossAssetDetail = 'JPY et US10Y divergents → pas de confirmation';
            crossAssetState = 'neutral';
        }
    } else if (jpySignal !== 0 || us10ySignal !== 0) {
        const s = jpySignal || us10ySignal;
        crossAssetScore = s * W.crossAssetConfirm * 0.5;
        crossAssetDetail = (jpySignal ? 'JPY seul ' : 'US10Y seul ') + (s > 0 ? 'baissier → favorable (poids réduit)' : 'haussier → défavorable (poids réduit)');
        crossAssetState = s > 0 ? 'favorable' : 'unfavorable';
    }
    score += crossAssetScore;
    reasons.push({ label: 'Confirmation Cross-Asset (JPY+US10Y fusionnés)', detail: crossAssetDetail, state: crossAssetState });

    // 5. Proximité d'un niveau de liquidité clé : poids configurable, défaut ±1
    const nearSupport = Math.abs(distToAsiaLow) < 0.15 || Math.abs(distToPdl) < 0.15;
    const nearResistance = Math.abs(distToAsiaHigh) < 0.15 || Math.abs(distToPdh) < 0.15;
    if (nearSupport && !nearResistance) {
        score += W.liquidityIntraday;
        reasons.push({ label: 'Liquidité Intraday', detail: "Test d'un support clé", state: 'favorable' });
    } else if (nearResistance && !nearSupport) {
        score -= W.liquidityIntraday;
        reasons.push({ label: 'Liquidité Intraday', detail: "Test d'une résistance clé", state: 'unfavorable' });
    } else {
        reasons.push({ label: 'Liquidité Intraday', detail: 'Pas de niveau testé', state: 'neutral' });
    }

    // 6. RSI Daily (diversification de temporalité — corrélé au prix mais sur un
    // horizon différent du RSI M15, donc pas un pur doublon) : poids léger, défaut ±0.5
    if (curDaily && curDaily.rsi14 !== null && curDaily.rsi14 !== undefined) {
        score += ((50 - curDaily.rsi14) / 50) * W.dailyRsi;
        let rsiDailyState = 'neutral';
        if (curDaily.rsi14 > 70) rsiDailyState = 'unfavorable';
        else if (curDaily.rsi14 < 30) rsiDailyState = 'favorable';
        reasons.push({ label: 'RSI Daily', detail: curDaily.rsi14.toFixed(0), state: rsiDailyState });
    }

    // 7. Debasement Trade : anticipations d'inflation (breakeven 5 ans) en hausse
    // pendant que le taux réel ne monte pas = signal classique de "fuite vers l'or"
    // face à la dévaluation monétaire anticipée. Poids léger, défaut ±0.5.
    if (daily && daily.length >= 10 && curDaily && curDaily.breakeven !== null && curDaily.breakeven !== undefined) {
        const prevDays = daily.slice(-10);
        const beList = prevDays.map(d => d.breakeven).filter(v => v !== null && v !== undefined);
        if (beList.length >= 5) {
            const beAvg = beList.slice(0, -1).reduce((a, b) => a + b, 0) / (beList.length - 1);
            const beDelta = curDaily.breakeven - beAvg;
            let beState = 'neutral';
            if (beDelta >= 0.03) {
                score += W.debasementTrade;
                beState = 'favorable';
            } else if (beDelta <= -0.03) {
                score -= W.debasementTrade;
                beState = 'unfavorable';
            }
            reasons.push({
                label: 'Inflation Anticipée (5 ans)',
                detail: `${curDaily.breakeven.toFixed(2)}% (${beDelta >= 0 ? '+' : ''}${beDelta.toFixed(2)} vs moy.)`,
                state: beState
            });
        }
    }

    // 8. COT Managed Money — positionnement spéculatif COMEX Gold, CONTRARIAN.
    // Vraiment indépendante des autres facteurs (positionnement institutionnel,
    // pas prix ni taux). Rapport hebdo avec ~3 jours de lag structurel -> poids
    // volontairement limité, défaut ±1. z-score calculé côté Update-Data.ps1.
    if (cot && cot.netZ !== null && cot.netZ !== undefined) {
        const extremeZ = cfg.cot?.extremeZ ?? 1.5;
        let cotContribution = 0;
        let cotState = 'neutral';
        let cotDetail = `z=${cot.netZ.toFixed(2)} (${cot.reportDate || 'n/a'})`;
        if (cot.netZ >= extremeZ) {
            // Managed Money extrêmement long -> positionnement fragile, risque de dégagement -> tilt baissier
            cotContribution = -W.cotContrarian * Math.min(1, (cot.netZ - extremeZ) / 1 + 0.5);
            cotState = 'unfavorable';
            cotDetail += ' — long extrême, contrarian baissier';
        } else if (cot.netZ <= -extremeZ) {
            cotContribution = W.cotContrarian * Math.min(1, (-cot.netZ - extremeZ) / 1 + 0.5);
            cotState = 'favorable';
            cotDetail += ' — short extrême, contrarian haussier';
        } else {
            cotDetail += ' — pas de positionnement extrême';
        }
        score += cotContribution;
        reasons.push({ label: 'COT Managed Money (contrarian)', detail: cotDetail, state: cotState });
    } else {
        reasons.push({ label: 'COT Managed Money (contrarian)', detail: 'Donnée indisponible cette semaine', state: 'neutral' });
    }

    const maxScore = cfg.maxScore || (W.macroRegime + W.priceActionM15 + W.crossAssetConfirm + W.liquidityIntraday + W.dailyRsi + W.debasementTrade + W.cotContrarian);
    const confidence = Math.min(10, Math.round((Math.abs(score) / maxScore) * 10));
    const strongCut = maxScore * (cfg.thresholds?.strongEdgeFraction ?? 0.5);
    const moderateCut = maxScore * (cfg.thresholds?.moderateEdgeFraction ?? 0.25);

    let verdict, title, subtitle;
    if (score >= strongCut) {
        verdict = 'buy';
        title = 'ACHETER — Edge Fort';
        subtitle = "La majorité des facteurs indépendants (macro, prix, cross-asset, positionnement) s'alignent en faveur de l'achat.";
    } else if (score >= moderateCut) {
        verdict = 'buy';
        title = 'ACHETER — Edge Modéré';
        subtitle = "Plusieurs facteurs favorisent l'achat, mais restez sélectif sur l'entrée.";
    } else if (score <= -strongCut) {
        verdict = 'sell';
        title = 'VENDRE — Edge Fort';
        subtitle = "La majorité des facteurs indépendants s'alignent en faveur de la vente.";
    } else if (score <= -moderateCut) {
        verdict = 'sell';
        title = 'VENDRE — Edge Modéré';
        subtitle = 'Plusieurs facteurs favorisent la vente, mais restez sélectif sur l\'entrée.';
    } else {
        verdict = 'wait';
        title = "ATTENDRE — Pas d'Edge Clair";
        subtitle = 'Les signaux sont mitigés ou contradictoires. Ne forcez pas une position.';
    }

    return { verdict, title, subtitle, score, maxScore, confidence, reasons, adrPct };
}

// Affiche le verdict unifié dans la carte "Mon Edge"
function renderVerdictUI(result) {
    const card = document.getElementById('verdict-card');
    const iconEl = document.getElementById('verdict-icon');
    const titleEl = document.getElementById('verdict-title');
    const subtitleEl = document.getElementById('verdict-subtitle');
    const barFill = document.getElementById('confidence-bar-fill');
    const confidenceValueEl = document.getElementById('confidence-value');
    const reasonsEl = document.getElementById('verdict-reasons');
    const warningEl = document.getElementById('verdict-warning');
    const warningTextEl = document.getElementById('verdict-warning-text');

    card.className = `card verdict-card verdict-${result.verdict}`;
    titleEl.innerText = result.title;
    subtitleEl.innerText = result.subtitle;

    const iconName = result.verdict === 'buy' ? 'trending-up' : (result.verdict === 'sell' ? 'trending-down' : 'clock');
    iconEl.innerHTML = `<i data-lucide="${iconName}"></i>`;

    barFill.style.width = `${result.confidence * 10}%`;
    barFill.style.backgroundColor = result.verdict === 'buy'
        ? 'var(--color-green)'
        : (result.verdict === 'sell' ? 'var(--color-red)' : 'var(--color-orange)');
    confidenceValueEl.innerText = `${result.confidence} / 10`;

    reasonsEl.innerHTML = result.reasons.map(r => {
        const icon = r.state === 'favorable' ? 'arrow-up-right' : (r.state === 'unfavorable' ? 'arrow-down-right' : 'minus');
        return `<div class="verdict-reason-item reason-${r.state}">
            <i data-lucide="${icon}"></i>
            <span><strong>${r.label} :</strong> ${r.detail}</span>
        </div>`;
    }).join('');

    if (result.adrPct >= 90) {
        warningEl.style.display = 'flex';
        warningTextEl.innerText = `Le range journalier (ADR) est déjà rempli à ${result.adrPct.toFixed(0)}%. Le mouvement est possiblement épuisé : réduisez la taille de position ou attendez la prochaine session.`;
    } else {
        warningEl.style.display = 'none';
    }
}

// Calcule et affiche le Stop-Loss / Objectif basés sur l'ATR quotidien.
// Objectif : des distances assez larges pour tenir une position M15 jusqu'à
// une session complète (~1 jour) sans se faire sortir par du bruit normal.
function renderRiskManagement(daily, currentPrice, verdict) {
    const atrEl = document.getElementById('risk-atr');
    const slEl = document.getElementById('risk-sl');
    const tpEl = document.getElementById('risk-tp');
    const noteEl = document.getElementById('risk-note');
    if (!atrEl || !slEl || !tpEl) return;

    const atrSeries = calculateATR(daily, 14);
    const atr14 = atrSeries[atrSeries.length - 1];
    window.__latestAtr = atr14 || null;

    if (atr14 === null || atr14 === undefined) {
        atrEl.innerText = 'Données insuffisantes';
        slEl.innerText = '-';
        tpEl.innerText = '-';
        return;
    }

    const atrPct = (atr14 / currentPrice) * 100;
    atrEl.innerText = `$${atr14.toFixed(2)} (${atrPct.toFixed(2)}%)`;

    if (verdict === 'buy') {
        const sl = currentPrice - atr14;
        const tp = currentPrice + (atr14 * 2);
        slEl.innerText = `$${sl.toFixed(2)} (-$${atr14.toFixed(2)})`;
        tpEl.innerText = `$${tp.toFixed(2)} (+$${(atr14 * 2).toFixed(2)})`;
        if (noteEl) noteEl.innerText = "Ce stop est volontairement large : il est fait pour survivre à une journée de bruit M15, pas pour être serré. Si votre thèse (macro + M15 + corrélations) tient toujours, une mèche contre vous qui reste au-dessus de ce niveau n'est pas une raison de couper.";
    } else if (verdict === 'sell') {
        const sl = currentPrice + atr14;
        const tp = currentPrice - (atr14 * 2);
        slEl.innerText = `$${sl.toFixed(2)} (+$${atr14.toFixed(2)})`;
        tpEl.innerText = `$${tp.toFixed(2)} (-$${(atr14 * 2).toFixed(2)})`;
        if (noteEl) noteEl.innerText = "Ce stop est volontairement large : il est fait pour survivre à une journée de bruit M15, pas pour être serré. Si votre thèse (macro + M15 + corrélations) tient toujours, une mèche contre vous qui reste en-dessous de ce niveau n'est pas une raison de couper.";
    } else {
        slEl.innerText = `± $${atr14.toFixed(2)}`;
        tpEl.innerText = `± $${(atr14 * 2).toFixed(2)}`;
        if (noteEl) noteEl.innerText = "Pas de direction claire pour l'instant (voir Mon Edge ci-dessus) — ces distances vous donnent déjà une idée du stop/objectif à utiliser si un signal se confirme.";
    }
}

// ==========================================
// SUIVI DE THÈSE DE TRADE (Hold vs Watch vs Cut)
// ==========================================
// Objectif : donner une règle objective pour tenir un trade M15 jusqu'à une
// journée, au lieu de couper à cause d'une simple mèche. On enregistre le
// verdict "Mon Edge" au moment de l'entrée, puis on le compare en continu à
// l'état actuel : tant que le verdict n'est pas passé du côté opposé, on tient.
const TRADE_STORAGE_KEY = 'goldEdgeActiveTrade';
const TRADE_HISTORY_KEY = 'goldEdgeTradeHistory';
const TRADE_MAX_HOLD_HOURS = 24;
const TRADE_WARNING_HOURS = 20;

function saveActiveTrade(verdictResult, currentPrice) {
    const trade = {
        direction: verdictResult.verdict, // 'buy' ou 'sell'
        entryPrice: currentPrice,
        entryAtr: window.__latestAtr || null, // pour calculer le R réalisé à la clôture
        entryTime: new Date().toISOString(),
        entryTitle: verdictResult.title,
        entryReasons: verdictResult.reasons,
        entryFavorableCount: verdictResult.reasons.filter(r =>
            (verdictResult.verdict === 'buy' && r.state === 'favorable') ||
            (verdictResult.verdict === 'sell' && r.state === 'unfavorable')
        ).length
    };
    try {
        localStorage.setItem(TRADE_STORAGE_KEY, JSON.stringify(trade));
    } catch (e) {
        console.error('Impossible de sauvegarder le trade :', e);
    }
    return trade;
}

function loadActiveTrade() {
    try {
        const raw = localStorage.getItem(TRADE_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function clearActiveTrade() {
    try {
        localStorage.removeItem(TRADE_STORAGE_KEY);
    } catch (e) { /* ignore */ }
}

// --- JOURNAL DE TRADES CLÔTURÉS : R réalisé, win rate, expectancy ---
// Sans ça, impossible de savoir objectivement si le système gagne de l'argent.
function loadTradeHistory() {
    try {
        const raw = localStorage.getItem(TRADE_HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveTradeToHistory(closedTrade) {
    try {
        const history = loadTradeHistory();
        history.push(closedTrade);
        // Garde les 500 derniers trades pour ne pas saturer localStorage
        const trimmed = history.slice(-500);
        localStorage.setItem(TRADE_HISTORY_KEY, JSON.stringify(trimmed));
    } catch (e) {
        console.error('Impossible de sauvegarder le trade dans le journal :', e);
    }
}

function computeJournalStats() {
    const history = loadTradeHistory();
    if (history.length === 0) return null;

    const withR = history.filter(t => typeof t.realizedR === 'number' && isFinite(t.realizedR));
    const wins = withR.filter(t => t.realizedR > 0);
    const losses = withR.filter(t => t.realizedR <= 0);
    const winRate = withR.length > 0 ? (wins.length / withR.length) * 100 : null;
    const avgWinR = wins.length > 0 ? wins.reduce((a, t) => a + t.realizedR, 0) / wins.length : 0;
    const avgLossR = losses.length > 0 ? losses.reduce((a, t) => a + t.realizedR, 0) / losses.length : 0;
    const expectancyR = withR.length > 0
        ? ((winRate / 100) * avgWinR) + ((1 - winRate / 100) * avgLossR)
        : null;

    return {
        totalTrades: history.length,
        scoredTrades: withR.length,
        winRate, avgWinR, avgLossR, expectancyR
    };
}

function renderJournalStats() {
    const el = document.getElementById('journal-stats-body');
    if (!el) return;
    const stats = computeJournalStats();
    if (!stats || stats.scoredTrades === 0) {
        el.innerHTML = `<p class="thesis-empty-text">Aucun trade clôturé avec R calculé pour l'instant. Enregistrez un trade, puis clôturez-le en indiquant le prix de sortie — le R réalisé, le win rate et l'expectancy s'accumuleront ici trade après trade.</p>`;
        return;
    }
    const wrColor = stats.winRate >= 50 ? 'var(--color-green)' : 'var(--color-red)';
    const expColor = stats.expectancyR >= 0 ? 'var(--color-green)' : 'var(--color-red)';
    el.innerHTML = `
        <div class="risk-grid">
            <div class="risk-item">
                <span class="risk-label">Trades Clôturés (avec R)</span>
                <span class="risk-value">${stats.scoredTrades} / ${stats.totalTrades}</span>
            </div>
            <div class="risk-item">
                <span class="risk-label">Win Rate</span>
                <span class="risk-value" style="color:${wrColor}">${stats.winRate.toFixed(0)}%</span>
            </div>
            <div class="risk-item">
                <span class="risk-label">Gain Moyen / Perte Moyenne</span>
                <span class="risk-value">+${stats.avgWinR.toFixed(2)}R / ${stats.avgLossR.toFixed(2)}R</span>
            </div>
            <div class="risk-item">
                <span class="risk-label">Expectancy</span>
                <span class="risk-value" style="color:${expColor}">${stats.expectancyR >= 0 ? '+' : ''}${stats.expectancyR.toFixed(2)}R / trade</span>
            </div>
        </div>
        <p class="risk-note">Expectancy = espérance de gain en multiples de R par trade, sur l'échantillon ci-dessus. Sous ~30 trades, ces chiffres ne sont pas statistiquement fiables — traitez-les comme une tendance à surveiller, pas une preuve.</p>
    `;
}

function handleSaveTradeClick() {
    if (!window.__latestVerdictResult || !window.__latestPrice) return;
    const verdictResult = window.__latestVerdictResult;
    if (verdictResult.verdict !== 'buy' && verdictResult.verdict !== 'sell') return;

    saveActiveTrade(verdictResult, window.__latestPrice);
    renderTradeThesisUI(verdictResult, window.__latestPrice);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function handleCloseTradeClick() {
    const trade = loadActiveTrade();
    if (trade) {
        const exitInput = window.prompt(
            `Clôture du trade ${trade.direction === 'buy' ? 'ACHAT' : 'VENTE'} entré à $${Number(trade.entryPrice).toFixed(2)}.\n\nPrix de sortie (laissez vide pour utiliser le prix actuel $${window.__latestPrice ? window.__latestPrice.toFixed(2) : '-'}) :`,
            ''
        );
        if (exitInput !== null) { // null = annulé -> on ne clôture rien
            const exitPrice = exitInput.trim() === '' ? window.__latestPrice : parseFloat(exitInput.replace(',', '.'));
            if (exitPrice && isFinite(exitPrice)) {
                const priceDelta = trade.direction === 'buy' ? (exitPrice - trade.entryPrice) : (trade.entryPrice - exitPrice);
                const realizedR = (trade.entryAtr && trade.entryAtr > 0) ? (priceDelta / trade.entryAtr) : null;
                saveTradeToHistory({
                    direction: trade.direction,
                    entryPrice: trade.entryPrice,
                    exitPrice: exitPrice,
                    entryAtr: trade.entryAtr,
                    entryTime: trade.entryTime,
                    exitTime: new Date().toISOString(),
                    priceDelta,
                    realizedR
                });
            }
            clearActiveTrade();
        } else {
            return; // annulé : on ne touche pas au trade actif
        }
    } else {
        clearActiveTrade();
    }
    renderTradeThesisUI(window.__latestVerdictResult, window.__latestPrice);
    renderJournalStats();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function formatElapsedTime(entryTimeIso) {
    const entryDate = new Date(entryTimeIso);
    const elapsedMs = Date.now() - entryDate.getTime();
    const hours = Math.floor(elapsedMs / 3600000);
    const minutes = Math.floor((elapsedMs % 3600000) / 60000);
    if (hours <= 0) return `${minutes} min`;
    return `${hours} h ${minutes} min`;
}

function renderTradeThesisUI(currentVerdictResult, currentPrice) {
    const emptyState = document.getElementById('thesis-empty-state');
    const activeState = document.getElementById('thesis-active-state');
    const saveBtn = document.getElementById('btn-save-trade');
    if (!emptyState || !activeState) return;

    // Le bouton "Enregistrer" n'est actif que si Mon Edge dit BUY ou SELL
    if (saveBtn) {
        const canSave = currentVerdictResult && (currentVerdictResult.verdict === 'buy' || currentVerdictResult.verdict === 'sell');
        saveBtn.disabled = !canSave;
    }

    const trade = loadActiveTrade();

    if (!trade) {
        emptyState.style.display = 'block';
        activeState.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    activeState.style.display = 'block';

    const directionLabel = trade.direction === 'buy' ? 'ACHAT (LONG)' : 'VENTE (SHORT)';
    document.getElementById('thesis-direction-title').innerText = directionLabel;
    document.getElementById('thesis-entry-price').innerText = `$${trade.entryPrice.toFixed(2)}`;
    document.getElementById('thesis-elapsed').innerText = formatElapsedTime(trade.entryTime);

    const totalReasons = trade.entryReasons.length;
    document.getElementById('thesis-entry-count').innerText = `${trade.entryFavorableCount} / ${totalReasons} facteurs`;

    // Compter combien de facteurs soutiennent encore la direction du trade, maintenant
    const currentReasons = (currentVerdictResult && currentVerdictResult.reasons) ? currentVerdictResult.reasons : [];
    let currentSupportiveCount = 0;
    const comparisonRows = [];

    trade.entryReasons.forEach(entryReason => {
        const nowReason = currentReasons.find(r => r.label === entryReason.label);
        const isSupportiveNow = nowReason && (
            (trade.direction === 'buy' && nowReason.state === 'favorable') ||
            (trade.direction === 'sell' && nowReason.state === 'unfavorable')
        );
        if (isSupportiveNow) currentSupportiveCount++;

        comparisonRows.push({
            label: entryReason.label,
            entryDetail: entryReason.detail,
            nowDetail: nowReason ? nowReason.detail : '—',
            stillOk: isSupportiveNow
        });
    });

    document.getElementById('thesis-current-count').innerText = `${currentSupportiveCount} / ${totalReasons} facteurs`;

    // Verdict HOLD / WATCH / CUT : basé avant tout sur le verdict global actuel,
    // qui utilise déjà la logique stabilisée (confirmation multi-bougies M15).
    const banner = document.getElementById('thesis-verdict-banner');
    const icon = document.getElementById('thesis-verdict-icon');
    const text = document.getElementById('thesis-verdict-text');
    const currentVerdict = currentVerdictResult ? currentVerdictResult.verdict : 'wait';
    const isOpposite = (trade.direction === 'buy' && currentVerdict === 'sell') ||
                        (trade.direction === 'sell' && currentVerdict === 'buy');
    const isSameDirection = currentVerdict === trade.direction;

    let stateClass, iconName, message;
    if (isOpposite) {
        stateClass = 'thesis-cut';
        iconName = 'alert-octagon';
        message = "THÈSE INVALIDÉE — Mon Edge est passé du côté opposé. C'est le signal le plus fort pour envisager de couper.";
    } else if (isSameDirection) {
        stateClass = 'thesis-hold';
        iconName = 'check-circle';
        message = `THÈSE TOUJOURS VALIDE — Mon Edge est encore du bon côté (${currentSupportiveCount}/${totalReasons} facteurs favorables). Rien n'indique qu'il faille couper.`;
    } else {
        stateClass = 'thesis-watch';
        iconName = 'eye';
        message = "THÈSE AFFAIBLIE — les signaux sont devenus mitigés (Mon Edge est en ATTENTE). Ce n'est pas encore un signal de sortie, mais surveillez d'un peu plus près.";
    }
    banner.className = `thesis-verdict-banner ${stateClass}`;
    icon.setAttribute('data-lucide', iconName);
    text.innerText = message;

    // Avertissement basé sur le temps (vous avez dit : max ~1 jour)
    const elapsedMs = Date.now() - new Date(trade.entryTime).getTime();
    const elapsedHours = elapsedMs / 3600000;
    const timeWarning = document.getElementById('thesis-time-warning');
    const timeWarningText = document.getElementById('thesis-time-warning-text');
    if (elapsedHours >= TRADE_MAX_HOLD_HOURS) {
        timeWarning.style.display = 'flex';
        timeWarningText.innerText = `Ce trade est ouvert depuis plus de 24h — votre limite de temps habituelle. Même si la thèse tient, envisagez de clôturer ou de sécuriser une partie de la position.`;
    } else if (elapsedHours >= TRADE_WARNING_HOURS) {
        timeWarning.style.display = 'flex';
        timeWarningText.innerText = `Ce trade approche de votre limite de 24h (déjà ${Math.floor(elapsedHours)}h). Commencez à surveiller la clôture.`;
    } else {
        timeWarning.style.display = 'none';
    }

    // Détail facteur par facteur
    const compareEl = document.getElementById('thesis-reasons-compare');
    compareEl.innerHTML = comparisonRows.map(row => `
        <div class="thesis-reason-row ${row.stillOk ? 'still-ok' : 'flipped'}">
            <span>${row.label} : ${row.entryDetail} → ${row.nowDetail}</span>
            <span class="thesis-reason-status">${row.stillOk ? 'OK' : 'BASCULÉ'}</span>
        </div>
    `).join('');
}

function updateLevelStatus(id, price, levelVal, side) {
    const el = document.getElementById(`level-${id}`);
    const statusEl = document.getElementById(`status-${id}`);
    
    const pctDiff = ((price - levelVal) / levelVal) * 100;
    const absDiff = Math.abs(pctDiff);

    el.className = 'level-row';

    if (absDiff < 0.04) {
        el.classList.add('sweep-risk');
        statusEl.innerText = 'SWEEP RISK';
    } else if (pctDiff > 0 && side === 'high') {
        el.classList.add('swept');
        statusEl.innerText = 'CASSÉ (UP)';
    } else if (pctDiff < 0 && side === 'low') {
        el.classList.add('swept');
        statusEl.innerText = 'CASSÉ (DOWN)';
    } else if (absDiff < 0.1 && side !== 'neutral') {
        el.classList.add('tested');
        statusEl.innerText = 'TESTÉ';
    } else {
        statusEl.innerText = 'STABLE';
    }
}

function getM15Trend(m15Data, key, confirmCandles, bufferPct, dropLastCandle) {
    const cfg = (window.SCORING_CONFIG || FALLBACK_SCORING_CONFIG).m15Trend;
    if (confirmCandles === undefined) confirmCandles = cfg.confirmCandles;
    if (bufferPct === undefined) bufferPct = cfg.bufferPct;
    if (dropLastCandle === undefined) dropLastCandle = cfg.dropLastCandle;

    // FIX REPAINT : la dernière bougie M15 renvoyée par Yahoo est en général
    // EN FORMATION (pas encore clôturée). La compter dans l'EMA/la tendance
    // fait clignoter le verdict en cours de bougie, puis revenir en arrière
    // à la clôture -> faux signaux (et fausses alertes Telegram). On l'exclut
    // systématiquement : la tendance ne réagit qu'à des bougies clôturées.
    // (Le H4 dérivé du M15 est déjà purgé de sa bougie incomplète côté fetch
    // -> appelé avec dropLastCandle=false pour ne pas perdre une bougie de plus.)
    const source = dropLastCandle && m15Data.length > 1 ? m15Data.slice(0, -1) : m15Data;

    // Calculer les EMA 9 et 50 de la série cible
    // On filtre les valeurs null/undefined (ex: JPY/US10Y pas encore disponibles
    // en début de série) pour éviter qu'elles soient comptées comme des 0,
    // ce qui faussait les EMA et donc les signaux.
    const values = source.map(d => d[key]).filter(v => v !== null && v !== undefined);
    if (values.length < 50 + confirmCandles) return 'neutral';

    const ema9 = calculateEMA(values, 9);
    const ema50 = calculateEMA(values, 50);

    // STABILITÉ M15 : on exige que la condition (bullish OU bearish) soit vraie
    // sur les `confirmCandles` dernières bougies M15, avec une petite zone
    // tampon autour de l'EMA 50 (`bufferPct`), plutôt que de réagir à la
    // dernière bougie seule. Ça évite que le signal parte dans tous les sens
    // à cause d'une simple mèche ou d'un léger va-et-vient autour de la ligne.
    let allBullish = true;
    let allBearish = true;
    for (let i = values.length - confirmCandles; i < values.length; i++) {
        const v = values[i];
        const e9 = ema9[i];
        const e50 = ema50[i];
        if (e9 === null || e50 === null) { allBullish = false; allBearish = false; break; }
        const bufferAbs = Math.abs(e50) * (bufferPct / 100);
        const bullish = e9 > e50 && v > (e50 + bufferAbs);
        const bearish = e9 < e50 && v < (e50 - bufferAbs);
        if (!bullish) allBullish = false;
        if (!bearish) allBearish = false;
    }

    if (allBullish) return 'bullish';
    if (allBearish) return 'bearish';
    return 'neutral';
}

function formatTrendCell(trend) {
    if (trend === 'bullish') {
        return '<span style="color: var(--color-green); font-weight: 700;"><i data-lucide="trending-up" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Haussière</span>';
    }
    if (trend === 'bearish') {
        return '<span style="color: var(--color-red); font-weight: 700;"><i data-lucide="trending-down" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Baissière</span>';
    }
    return '<span style="color: var(--text-muted);">Range / Neutre</span>';
}

function updateCorrelationBadge(badgeId, trend, targetFavorable) {
    const el = document.getElementById(badgeId);
    el.className = 'state-badge';
    
    if (trend === 'neutral') {
        el.classList.add('neutral');
        el.innerText = 'NEUTRE';
    } else if (trend === targetFavorable) {
        el.classList.add('bullish');
        el.innerText = 'FAVORABLE';
    } else {
        el.classList.add('bearish');
        el.innerText = 'CONTRAIRE';
    }
}

function addAlertBadge(text, type, title, container) {
    const badge = document.createElement('span');
    badge.className = `alert-tag ${type === 'bull' ? 'active-bull' : 'active-bear'}`;
    badge.title = title;
    badge.innerHTML = `<i data-lucide="${type === 'bull' ? 'arrow-up-right' : 'arrow-down-right'}"></i> ${text}`;
    container.appendChild(badge);
}

// Biais Macro Long Terme
function evaluateMacroChecklist(dailyData) {
    const current = dailyData[dailyData.length - 1];
    const prevDays = dailyData.slice(-10);
    const checklist = [];

    // Taux réels 10Y
    const ryList = prevDays.map(d => d.realYield).filter(v => v !== null);
    let ryState = 'neutral';
    if (ryList.length >= 2) {
        const ryAvg = ryList.slice(0, -1).reduce((a, b) => a + b, 0) / (ryList.length - 1);
        if (current.realYield <= ryAvg - 0.05) ryState = 'favorable';
        else if (current.realYield >= ryAvg + 0.05) ryState = 'defavorable';
        else ryState = 'neutral';
    }
    checklist.push({ state: ryState });

    // DXY
    const dxyList = prevDays.map(d => d.dxy).filter(v => v !== null);
    let dxyState = 'neutral';
    if (dxyList.length >= 5) {
        const dxySma = dxyList.reduce((a, b) => a + b, 0) / dxyList.length;
        if (current.dxy < dxySma) dxyState = 'favorable';
        else dxyState = 'defavorable';
    }
    checklist.push({ state: dxyState });

    // Yield Curve
    if (current.yieldCurve !== null) {
        checklist.push({ state: current.yieldCurve < 0 ? 'favorable' : 'defavorable' });
    }

    // Ratio Gold/Oil (Percentile)
    const ratios = dailyData.map(d => d.goldOilRatio).filter(v => v !== null);
    if (ratios.length > 50 && current.goldOilRatio) {
        const sorted = [...ratios].sort((a,b) => a-b);
        const rank = sorted.indexOf(current.goldOilRatio);
        const pct = (rank / sorted.length) * 100;
        checklist.push({ state: pct < 30 ? 'favorable' : (pct > 70 ? 'defavorable' : 'neutral') });
    }

    // XLP/XLY
    const xxList = prevDays.map(d => d.xlpXlyRatio).filter(v => v !== null);
    let xxState = 'neutral';
    if (xxList.length >= 5) {
        const xxSma = xxList.reduce((a, b) => a + b, 0) / xxList.length;
        xxState = current.xlpXlyRatio > xxSma ? 'favorable' : 'defavorable';
    }
    checklist.push({ state: xxState });

    return checklist;
}

// Rendu des graphiques M15 et Daily
function initCharts(processed) {
    const daily = processed.dailyAligned;
    const m15 = processed.m15Aligned;

    const chartOptions = {
        layout: {
            background: { type: 'solid', color: '#0F131E' },
            textColor: '#9CA3AF',
            fontSize: 11,
            fontFamily: 'Outfit, sans-serif'
        },
        grid: {
            vertLines: { color: '#1E2538' },
            horzLines: { color: '#1E2538' }
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: 'rgba(229, 184, 66, 0.4)', width: 1, style: 2 },
            horzLine: { color: 'rgba(229, 184, 66, 0.4)', width: 1, style: 2 }
        },
        rightPriceScale: { borderColor: '#1E2538', visible: true },
        leftPriceScale: { borderColor: '#1E2538', visible: false },
        timeScale: { borderColor: '#1E2538', fixLeftEdge: true },
        handleScale: { axisPressedMouseMove: true }
    };

    const chartsList = [];

    // --- CHART 1 : OR M15 + EMA 9 & EMA 50 ---
    const goldM15Container = document.getElementById('chart-gold-m15-container');
    const goldM15Chart = LightweightCharts.createChart(goldM15Container, chartOptions);
    chartsList.push(goldM15Chart);

    const candleSeries = goldM15Chart.addCandlestickSeries({
        upColor: '#10B981', downColor: '#EF4444',
        borderDownColor: '#EF4444', borderUpColor: '#10B981',
        wickDownColor: '#EF4444', wickUpColor: '#10B981'
    });

    const ema9Series = goldM15Chart.addLineSeries({ color: '#38BDF8', lineWidth: 1.5 });
    const ema50Series = goldM15Chart.addLineSeries({ color: '#F43F5E', lineWidth: 2 });

    const candleData = m15.map(d => ({
        time: d.time, open: d.open, high: d.high, low: d.low, close: d.close
    }));
    const ema9Data = m15.map(d => ({ time: d.time, value: d.ema9 })).filter(d => d.value !== null);
    const ema50Data = m15.map(d => ({ time: d.time, value: d.ema50 })).filter(d => d.value !== null);

    candleSeries.setData(candleData);
    ema9Series.setData(ema9Data);
    ema50Series.setData(ema50Data);
    
    // Configurer l'échelle horaire
    goldM15Chart.timeScale().applyOptions({ timeVisible: true });
    goldM15Chart.timeScale().fitContent();

    // --- CHART 2 : CORRÉLATIONS M15 (Gold vs USD/JPY vs US10Y) ---
    const corrContainer = document.getElementById('chart-correlations-m15-container');
    const corrChart = LightweightCharts.createChart(corrContainer, {
        ...chartOptions,
        leftPriceScale: { ...chartOptions.leftPriceScale, visible: true }
    });
    chartsList.push(corrChart);

    const goldLine = corrChart.addLineSeries({ color: '#E5B842', lineWidth: 2, priceScaleId: 'right' });
    const jpyLine = corrChart.addLineSeries({ color: '#06B6D4', lineWidth: 1.5, priceScaleId: 'left' });
    const us10yLine = corrChart.addLineSeries({ color: '#A855F7', lineWidth: 1.5, priceScaleId: 'left' });

    goldLine.setData(m15.map(d => ({ time: d.time, value: d.close })));
    jpyLine.setData(m15.map(d => ({ time: d.time, value: d.jpy })).filter(d => d.value !== null));
    us10yLine.setData(m15.map(d => ({ time: d.time, value: d.us10y })).filter(d => d.value !== null));
    
    corrChart.timeScale().applyOptions({ timeVisible: true });
    corrChart.timeScale().fitContent();

    // --- CHART 3 : OR DAILY + MM200 ---
    const dailyContainer = document.getElementById('chart-gold-daily-container');
    const dailyChart = LightweightCharts.createChart(dailyContainer, chartOptions);
    chartsList.push(dailyChart);

    const candleDailySeries = dailyChart.addCandlestickSeries({
        upColor: '#10B981', downColor: '#EF4444',
        borderDownColor: '#EF4444', borderUpColor: '#10B981',
        wickDownColor: '#EF4444', wickUpColor: '#10B981'
    });
    const sma200Series = dailyChart.addLineSeries({ color: '#4F6A9F', lineWidth: 2 });

    candleDailySeries.setData(daily.map(d => ({
        time: d.date, open: d.open, high: d.high, low: d.low, close: d.close
    })));
    sma200Series.setData(daily.map(d => ({ time: d.date, value: d.sma200 })).filter(d => d.value !== null));
    
    dailyChart.timeScale().fitContent();

    // --- CHART 4 : FILTRES MACRO DAILY (Gold vs Taux Réels Inversés) ---
    const macroContainer = document.getElementById('chart-macro-daily-container');
    const macroChart = LightweightCharts.createChart(macroContainer, {
        ...chartOptions,
        leftPriceScale: { ...chartOptions.leftPriceScale, visible: true }
    });
    chartsList.push(macroChart);

    const goldLineMacro = macroChart.addLineSeries({ color: '#E5B842', lineWidth: 2, priceScaleId: 'right' });
    const realYieldLine = macroChart.addLineSeries({ color: '#06B6D4', lineWidth: 1.5, priceScaleId: 'left' });

    goldLineMacro.setData(daily.map(d => ({ time: d.date, value: d.close })));
    realYieldLine.setData(daily.map(d => ({
        time: d.date, value: d.realYield !== null ? -d.realYield : null
    })).filter(d => d.value !== null));

    macroChart.timeScale().fitContent();

    // --- TABS MANAGEMENT ---
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const legendOverlay = document.getElementById('chart-legend-overlay');
    const legendPrimary = document.getElementById('legend-series-primary');
    const legendSecondary = document.getElementById('legend-series-secondary');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(tabId).classList.add('active');

            if (tabId === 'tab-gold-m15') {
                legendOverlay.style.display = 'flex';
                legendPrimary.innerText = 'Or M15 : Candlesticks';
                legendPrimary.style.color = 'var(--color-green)';
                legendSecondary.innerText = 'Bleu : EMA 9 | Rose : EMA 50';
                legendSecondary.style.color = '#38BDF8';
            } else if (tabId === 'tab-correlations-m15') {
                legendOverlay.style.display = 'flex';
                legendPrimary.innerText = 'Or M15 (Échelle Droite)';
                legendPrimary.style.color = '#E5B842';
                legendSecondary.innerText = 'Bleu : USD/JPY | Violet : US10Y (Échelle Gauche)';
                legendSecondary.style.color = '#06B6D4';
            } else if (tabId === 'tab-gold-daily') {
                legendOverlay.style.display = 'flex';
                legendPrimary.innerText = 'Or Daily : Candlesticks';
                legendPrimary.style.color = 'var(--color-green)';
                legendSecondary.innerText = 'Bleu : MM200 Jours';
                legendSecondary.style.color = '#4F6A9F';
            } else if (tabId === 'tab-macro-daily') {
                legendOverlay.style.display = 'flex';
                legendPrimary.innerText = 'Or Daily (Échelle Droite)';
                legendPrimary.style.color = '#E5B842';
                legendSecondary.innerText = 'Bleu : Taux Réels 10Y Inversés (Échelle Gauche)';
                legendSecondary.style.color = '#06B6D4';
            }

            setTimeout(() => {
                if (tabId === 'tab-gold-m15') {
                    goldM15Chart.resize(goldM15Container.clientWidth, goldM15Container.clientHeight);
                    goldM15Chart.timeScale().fitContent();
                } else if (tabId === 'tab-correlations-m15') {
                    corrChart.resize(corrContainer.clientWidth, corrContainer.clientHeight);
                    corrChart.timeScale().fitContent();
                } else if (tabId === 'tab-gold-daily') {
                    dailyChart.resize(dailyContainer.clientWidth, dailyContainer.clientHeight);
                    dailyChart.timeScale().fitContent();
                } else if (tabId === 'tab-macro-daily') {
                    macroChart.resize(macroContainer.clientWidth, macroContainer.clientHeight);
                    macroChart.timeScale().fitContent();
                }
            }, 50);
        });
    });

    // Default legends
    legendPrimary.innerText = 'Or M15 : Candlesticks';
    legendSecondary.innerText = 'Bleu : EMA 9 | Rose : EMA 50';

    window.addEventListener('resize', () => {
        const activeTab = document.querySelector('.tab-btn.active').getAttribute('data-tab');
        if (activeTab === 'tab-gold-m15') {
            goldM15Chart.resize(goldM15Container.clientWidth, goldM15Container.clientHeight);
        } else if (activeTab === 'tab-correlations-m15') {
            corrChart.resize(corrContainer.clientWidth, corrContainer.clientHeight);
        } else if (activeTab === 'tab-gold-daily') {
            dailyChart.resize(dailyContainer.clientWidth, dailyContainer.clientHeight);
        } else if (activeTab === 'tab-macro-daily') {
            macroChart.resize(macroContainer.clientWidth, macroContainer.clientHeight);
        }
    });
}
