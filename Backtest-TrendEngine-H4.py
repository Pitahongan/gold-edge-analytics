#!/usr/bin/env python3
"""
Backtest-TrendEngine-H4.py
===========================
Teste le moteur de tendance (croisement EMA9/50 + tampon + confirmation
sur N bougies, la meme logique que getM15Trend() dans app.js) combine a la
regle de sortie reellement codee dans renderRiskManagement() : stop = 1x
ATR14 quotidien, cible = 2x ATR14 quotidien (R:R 1:2), hold max 24h.

Source de donnees : export reel du broker XM (ExportH4History.mq5), H4,
2001-06-04 -> aujourd'hui, soit ~23500 bougies / 25 ans, TOUS regimes de
marche confondus (haussier, baissier, range) -- contrairement au backtest
macro (Backtest-MacroBias.py) qui n'a que 505 jours, tous dans un seul
marche haussier structurel.

Ce que ca NE teste PAS : le score macro (real yields/DXY/yield curve),
la confirmation cross-asset JPY/US10Y, le COT, la liquidite intraday
(Asia high/low, PDH/PDL) -- ces briques n'ont pas d'historique archive
sur 25 ans. Ce script isole donc le SEUL bloc "prix" du systeme (tendance
EMA + stop ATR), sur M15 remplace par H4 faute de mieux (pas 25 ans de
M15 disponibles). C'est un moteur PLUS LENT que le vrai systeme M15, donc
les resultats ne sont pas transposables tels quels au systeme complet --
mais si CE bloc n'a pas d'edge sur 25 ans et plusieurs regimes, c'est un
signal fort sur la brique EMA9/50 qui alimente aussi bien le scalp M15
que le biais quotidien.

Usage : python3 Backtest-TrendEngine-H4.py [chemin/vers/gold_h4_export.csv]
"""
import sys
import csv
from datetime import datetime, timedelta

CONFIRM_CANDLES = 2
BUFFER_PCT = 0.03       # scoring-config.json m15Trend.bufferPct
ATR_PERIOD = 14
MAX_HOLD_BARS_H4 = 6    # 6 x H4 = 24h
SPREAD_COST = 0.35      # cout aller-retour approx (spread XM Gold en $/oz), conservateur


def load_csv(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            t = datetime.strptime(r['time'], '%Y.%m.%d %H:%M')
            rows.append({
                'time': t,
                'open': float(r['open']),
                'high': float(r['high']),
                'low': float(r['low']),
                'close': float(r['close']),
            })
    rows.sort(key=lambda r: r['time'])
    return rows


def ema(values, period):
    out = [None] * len(values)
    if len(values) < period:
        return out
    s = sum(values[:period])
    prev = s / period
    out[period - 1] = prev
    k = 2 / (period + 1)
    for i in range(period, len(values)):
        cur = (values[i] - prev) * k + prev
        out[i] = cur
        prev = cur
    return out


def build_daily_bars(h4):
    by_date = {}
    for c in h4:
        d = c['time'].date()
        if d not in by_date:
            by_date[d] = {'date': d, 'open': c['open'], 'high': c['high'], 'low': c['low'], 'close': c['close']}
        else:
            day = by_date[d]
            day['high'] = max(day['high'], c['high'])
            day['low'] = min(day['low'], c['low'])
            day['close'] = c['close']
    return [by_date[d] for d in sorted(by_date.keys())]


def atr_wilder(daily, period):
    atr = [None] * len(daily)
    if len(daily) <= period:
        return atr
    tr = [None]
    for i in range(1, len(daily)):
        cur = daily[i]
        prev_close = daily[i - 1]['close']
        tr.append(max(cur['high'] - cur['low'], abs(cur['high'] - prev_close), abs(cur['low'] - prev_close)))
    avg = sum(tr[1:period + 1]) / period
    atr[period] = avg
    for i in range(period + 1, len(daily)):
        avg = (avg * (period - 1) + tr[i]) / period
        atr[i] = avg
    return atr


def trend_at(closes, ema9, ema50, i, confirm, buffer_pct):
    if i - confirm + 1 < 0:
        return 'neutral'
    all_bull, all_bear = True, True
    for k in range(i - confirm + 1, i + 1):
        e9, e50, v = ema9[k], ema50[k], closes[k]
        if e9 is None or e50 is None:
            return 'neutral'
        buf = abs(e50) * (buffer_pct / 100)
        bull = e9 > e50 and v > (e50 + buf)
        bear = e9 < e50 and v < (e50 - buf)
        if not bull:
            all_bull = False
        if not bear:
            all_bear = False
    if all_bull:
        return 'bullish'
    if all_bear:
        return 'bearish'
    return 'neutral'


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'gold_h4_export.csv'
    h4 = load_csv(path)
    print(f"Bougies H4 chargees : {len(h4)} ({h4[0]['time']} -> {h4[-1]['time']})")

    closes = [c['close'] for c in h4]
    ema9 = ema(closes, 9)
    ema50 = ema(closes, 50)

    daily = build_daily_bars(h4)
    atr14_daily = atr_wilder(daily, ATR_PERIOD)
    atr_by_date = {}
    for i, d in enumerate(daily):
        atr_by_date[d['date']] = atr14_daily[i]

    trades = []
    i = 50 + CONFIRM_CANDLES
    n = len(h4)
    in_position = False

    while i < n - 1:
        if not in_position:
            trend = trend_at(closes, ema9, ema50, i, CONFIRM_CANDLES, BUFFER_PCT)
            atr_today = atr_by_date.get(h4[i]['time'].date())
            # cherche le dernier ATR quotidien disponible <= date courante (forward-fill)
            if atr_today is None:
                for d in daily:
                    if d['date'] <= h4[i]['time'].date() and atr_by_date.get(d['date']) is not None:
                        atr_today = atr_by_date[d['date']]
            if trend in ('bullish', 'bearish') and atr_today:
                direction = 'buy' if trend == 'bullish' else 'sell'
                entry_idx = i + 1
                entry_price = h4[entry_idx]['open']
                if direction == 'buy':
                    sl = entry_price - atr_today
                    tp = entry_price + 2 * atr_today
                else:
                    sl = entry_price + atr_today
                    tp = entry_price - 2 * atr_today

                exit_price, exit_reason = None, None
                last_j = min(entry_idx + MAX_HOLD_BARS_H4, n - 1)
                for j in range(entry_idx, last_j + 1):
                    bar = h4[j]
                    if direction == 'buy':
                        if bar['low'] <= sl:
                            exit_price, exit_reason = sl, 'SL'
                            break
                        if bar['high'] >= tp:
                            exit_price, exit_reason = tp, 'TP'
                            break
                    else:
                        if bar['high'] >= sl:
                            exit_price, exit_reason = sl, 'SL'
                            break
                        if bar['low'] <= tp:
                            exit_price, exit_reason = tp, 'TP'
                            break
                if exit_price is None:
                    exit_price, exit_reason = h4[last_j]['close'], 'TIME'

                pnl = (exit_price - entry_price) if direction == 'buy' else (entry_price - exit_price)
                pnl -= SPREAD_COST
                r_multiple = pnl / atr_today
                trades.append({
                    'entry_time': h4[entry_idx]['time'], 'direction': direction,
                    'entry': entry_price, 'exit': exit_price, 'reason': exit_reason,
                    'pnl': pnl, 'r': r_multiple,
                })
                i = last_j + 1
                continue
        i += 1

    n_trades = len(trades)
    print(f"\nTrades generes (2001-2026, tendance EMA9/50 H4 + stop/cible ATR quotidien 1:2, cout {SPREAD_COST}$/trade) : {n_trades}")
    if n_trades == 0:
        print("Aucun trade genere -- verifier les donnees.")
        return

    wins = [t for t in trades if t['pnl'] > 0]
    losses = [t for t in trades if t['pnl'] <= 0]
    win_rate = len(wins) / n_trades * 100
    avg_r = sum(t['r'] for t in trades) / n_trades
    total_pnl = sum(t['pnl'] for t in trades)
    avg_win_r = sum(t['r'] for t in wins) / len(wins) if wins else 0
    avg_loss_r = sum(t['r'] for t in losses) / len(losses) if losses else 0

    r_values = [t['r'] for t in trades]
    variance = sum((r - avg_r) ** 2 for r in r_values) / (n_trades - 1)
    std_r = variance ** 0.5
    se_r = std_r / (n_trades ** 0.5)
    t_stat = avg_r / se_r if se_r else 0

    print(f"Win rate            : {win_rate:.1f}% ({len(wins)}W / {len(losses)}L)")
    print(f"Expectancy moyenne  : {avg_r:+.3f} R par trade  (ecart-type={std_r:.2f}R, erreur-type={se_r:.4f}R, t-stat={t_stat:.2f})")
    print(f"  -> {'STATISTIQUEMENT SIGNIFICATIF (|t|>2)' if abs(t_stat) > 2 else 'PAS significatif (|t|<2) : indiscernable du hasard sur cet echantillon'}")
    print(f"Gain moyen (W)      : {avg_win_r:+.2f} R   |  Perte moyenne (L) : {avg_loss_r:+.2f} R")
    print(f"PnL cumule (en $/oz, 1 lot theorique, sans compounding) : {total_pnl:+.2f}")

    by_reason = {}
    for t in trades:
        by_reason.setdefault(t['reason'], []).append(t)
    print("\nRepartition par type de sortie :")
    for reason, ts in by_reason.items():
        print(f"  {reason:5s} n={len(ts):5d}  win-rate={sum(1 for t in ts if t['pnl']>0)/len(ts)*100:.0f}%  avg_r={sum(t['r'] for t in ts)/len(ts):+.2f}")

    # Decoupage par decennie pour verifier la stabilite du edge dans le temps
    print("\nPar periode (edge stable dans le temps ?) :")
    buckets = {}
    for t in trades:
        key = f"{(t['entry_time'].year // 5) * 5}-{(t['entry_time'].year // 5) * 5 + 4}"
        buckets.setdefault(key, []).append(t)
    for key in sorted(buckets.keys()):
        ts = buckets[key]
        avg = sum(t['r'] for t in ts) / len(ts)
        wr = sum(1 for t in ts if t['pnl'] > 0) / len(ts) * 100
        print(f"  {key}  n={len(ts):5d}  expectancy={avg:+.3f}R  win-rate={wr:.0f}%")

    # Long vs short
    print("\nLong vs Short :")
    for d in ('buy', 'sell'):
        ts = [t for t in trades if t['direction'] == d]
        if not ts:
            continue
        avg = sum(t['r'] for t in ts) / len(ts)
        wr = sum(1 for t in ts if t['pnl'] > 0) / len(ts) * 100
        print(f"  {d:5s} n={len(ts):5d}  expectancy={avg:+.3f}R  win-rate={wr:.0f}%")

    print("\nInterpretation : expectancy > 0 = le moteur de tendance a un edge brut "
          "(avant frais de courtage/swap/slippage reels, ici seul un cout de spread "
          "forfaitaire est deduit). Expectancy proche de 0 ou negative = le croisement "
          "EMA9/50 seul, sans les autres filtres (macro/correlations/liquidite), ne "
          "suffit pas a generer un edge sur 25 ans et plusieurs regimes de marche.")


if __name__ == '__main__':
    main()
