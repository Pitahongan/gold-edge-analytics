#!/usr/bin/env python3
"""
Backtest-TrendEngine-MTF.py (Multi-TimeFrame)
================================================
Compare H4 vs D1 comme filtre de tendance, sur les 25 ans de donnees reelles
du broker XM (gold_h4_export.csv), avec la MEME mecanique de sortie que
Backtest-TrendEngine-H4.py (stop = 1x ATR quotidien, cible = 2x ATR quotidien,
hold max 24h) -- pour rester coherent avec l'architecture actuelle du systeme
(trades intraday, hold <=24h), et isoler UNE seule variable : la timeframe
du signal d'entree (H4 vs D1), poids/execution identiques sinon.

Egalement : frequence de changement de sens (whipsaw) de chaque timeframe sur
l'integralite des 25 ans, pas juste sur une fenetre de 4 jours -- pour
objectiver l'ecart de "bruit" entre M15 (deja mesure ailleurs), H4 et D1.

Usage : python3 Backtest-TrendEngine-MTF.py [gold_h4_export.csv]
"""
import sys
import csv
from datetime import datetime

CONFIRM_CANDLES = 2
BUFFER_PCT = 0.03
ATR_PERIOD = 14
MAX_HOLD_BARS_H4 = 6     # 24h en H4
MAX_HOLD_DAYS_D1 = 1     # 24h en D1 = 1 bougie (pour rester comparable)
SPREAD_COST = 0.35


def load_csv(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            t = datetime.strptime(r['time'], '%Y.%m.%d %H:%M')
            rows.append({'time': t, 'open': float(r['open']), 'high': float(r['high']),
                         'low': float(r['low']), 'close': float(r['close'])})
    rows.sort(key=lambda r: r['time'])
    return rows


def ema(values, period):
    out = [None] * len(values)
    if len(values) < period:
        return out
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    k = 2 / (period + 1)
    for i in range(period, len(values)):
        prev = (values[i] - prev) * k + prev
        out[i] = prev
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
        prev_close = daily[i - 1]['close']
        cur = daily[i]
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


def count_flips(trends):
    flips, prev = 0, None
    for t in trends:
        if prev is not None and t != prev and t != 'neutral' and prev != 'neutral':
            flips += 1
        if t != 'neutral':
            prev = t
    return flips


def simulate_h4_signal(h4, daily, atr_by_date, confirm, buffer_pct):
    closes = [c['close'] for c in h4]
    e9, e50 = ema(closes, 9), ema(closes, 50)
    trades = []
    i = 50 + confirm
    n = len(h4)
    while i < n - 1:
        trend = trend_at(closes, e9, e50, i, confirm, buffer_pct)
        atr_today = None
        for d in reversed(daily):
            if d['date'] <= h4[i]['time'].date() and atr_by_date.get(d['date']) is not None:
                atr_today = atr_by_date[d['date']]
                break
        if trend in ('bullish', 'bearish') and atr_today:
            direction = 'buy' if trend == 'bullish' else 'sell'
            entry_idx = i + 1
            entry = h4[entry_idx]['open']
            sl = entry - atr_today if direction == 'buy' else entry + atr_today
            tp = entry + 2 * atr_today if direction == 'buy' else entry - 2 * atr_today
            last_j = min(entry_idx + MAX_HOLD_BARS_H4, n - 1)
            exit_price, reason = None, None
            for j in range(entry_idx, last_j + 1):
                bar = h4[j]
                if direction == 'buy':
                    if bar['low'] <= sl:
                        exit_price, reason = sl, 'SL'; break
                    if bar['high'] >= tp:
                        exit_price, reason = tp, 'TP'; break
                else:
                    if bar['high'] >= sl:
                        exit_price, reason = sl, 'SL'; break
                    if bar['low'] <= tp:
                        exit_price, reason = tp, 'TP'; break
            if exit_price is None:
                exit_price, reason = h4[last_j]['close'], 'TIME'
            pnl = (exit_price - entry if direction == 'buy' else entry - exit_price) - SPREAD_COST
            trades.append({'time': h4[entry_idx]['time'], 'direction': direction, 'pnl': pnl, 'r': pnl / atr_today, 'reason': reason})
            i = last_j + 1
            continue
        i += 1
    return trades, trend_at.__self__ if False else None


def simulate_d1_signal(h4, daily, atr_by_date, confirm, buffer_pct):
    """Signal calcule sur cloture D1, mais EXECUTION en H4 (entree a l'ouverture
    du prochain H4 apres cloture du jour du signal, sortie avec le meme
    mecanisme ATR 1:2 / hold max 24h) -- pour tester le D1 comme filtre dans
    la MEME architecture intraday que le systeme actuel, pas comme un swing
    multi-jours a part."""
    d_closes = [d['close'] for d in daily]
    e9, e50 = ema(d_closes, 9), ema(d_closes, 50)
    daily_trend_by_date = {}
    for k in range(len(daily)):
        daily_trend_by_date[daily[k]['date']] = trend_at(d_closes, e9, e50, k, confirm, buffer_pct)

    trades = []
    n = len(h4)
    i = 0
    in_position_until = None
    last_date_traded = None
    while i < n - 1:
        cur_date = h4[i]['time'].date()
        # on ne regarde le signal D1 qu'une fois par jour (a la premiere bougie H4 du jour), en utilisant la cloture D1 de la VEILLE (pas de look-ahead)
        prev_dates = [d for d in daily_trend_by_date if d < cur_date]
        if not prev_dates:
            i += 1
            continue
        last_closed_date = max(prev_dates)
        trend = daily_trend_by_date[last_closed_date]
        atr_today = atr_by_date.get(last_closed_date)
        if trend in ('bullish', 'bearish') and atr_today and cur_date != last_date_traded:
            direction = 'buy' if trend == 'bullish' else 'sell'
            entry_idx = i
            entry = h4[entry_idx]['open']
            sl = entry - atr_today if direction == 'buy' else entry + atr_today
            tp = entry + 2 * atr_today if direction == 'buy' else entry - 2 * atr_today
            last_j = min(entry_idx + MAX_HOLD_BARS_H4, n - 1)
            exit_price, reason = None, None
            for j in range(entry_idx, last_j + 1):
                bar = h4[j]
                if direction == 'buy':
                    if bar['low'] <= sl:
                        exit_price, reason = sl, 'SL'; break
                    if bar['high'] >= tp:
                        exit_price, reason = tp, 'TP'; break
                else:
                    if bar['high'] >= sl:
                        exit_price, reason = sl, 'SL'; break
                    if bar['low'] <= tp:
                        exit_price, reason = tp, 'TP'; break
            if exit_price is None:
                exit_price, reason = h4[last_j]['close'], 'TIME'
            pnl = (exit_price - entry if direction == 'buy' else entry - exit_price) - SPREAD_COST
            trades.append({'time': h4[entry_idx]['time'], 'direction': direction, 'pnl': pnl, 'r': pnl / atr_today, 'reason': reason})
            last_date_traded = cur_date
            i = last_j + 1
            continue
        i += 1
    return trades


def report(name, trades):
    n = len(trades)
    print(f"\n=== {name} : {n} trades ===")
    if n == 0:
        print("  aucun trade")
        return
    wins = [t for t in trades if t['pnl'] > 0]
    wr = len(wins) / n * 100
    avg_r = sum(t['r'] for t in trades) / n
    var = sum((t['r'] - avg_r) ** 2 for t in trades) / (n - 1) if n > 1 else 0
    std = var ** 0.5
    se = std / (n ** 0.5) if n else 0
    t_stat = avg_r / se if se else 0
    print(f"  Win rate      : {wr:.1f}%")
    print(f"  Expectancy    : {avg_r:+.3f} R  (std={std:.2f}, t-stat={t_stat:.2f}) -> {'SIGNIFICATIF' if abs(t_stat) > 2 else 'non significatif'}")
    by_reason = {}
    for t in trades:
        by_reason.setdefault(t['reason'], []).append(t)
    for reason, ts in by_reason.items():
        print(f"    {reason:5s} n={len(ts):5d} ({len(ts)/n*100:.0f}%)  avg_r={sum(x['r'] for x in ts)/len(ts):+.2f}")
    for d in ('buy', 'sell'):
        ts = [t for t in trades if t['direction'] == d]
        if ts:
            print(f"    {d:5s} n={len(ts):5d}  expectancy={sum(x['r'] for x in ts)/len(ts):+.3f}R  win-rate={sum(1 for x in ts if x['pnl']>0)/len(ts)*100:.0f}%")
    # stabilite par periode de 5 ans
    buckets = {}
    for t in trades:
        key = f"{(t['time'].year//5)*5}-{(t['time'].year//5)*5+4}"
        buckets.setdefault(key, []).append(t)
    print("  Par période :")
    for key in sorted(buckets.keys()):
        ts = buckets[key]
        print(f"    {key}  n={len(ts):5d}  expectancy={sum(x['r'] for x in ts)/len(ts):+.3f}R")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'gold_h4_export.csv'
    h4 = load_csv(path)
    print(f"Bougies H4 : {len(h4)} ({h4[0]['time']} -> {h4[-1]['time']})")

    daily = build_daily_bars(h4)
    atr14 = atr_wilder(daily, ATR_PERIOD)
    atr_by_date = {daily[i]['date']: atr14[i] for i in range(len(daily))}

    # --- Frequence de changement de sens (whipsaw) sur TOUT l'historique ---
    h4_closes = [c['close'] for c in h4]
    e9h4, e50h4 = ema(h4_closes, 9), ema(h4_closes, 50)
    h4_trends_all = [trend_at(h4_closes, e9h4, e50h4, i, CONFIRM_CANDLES, BUFFER_PCT) for i in range(len(h4))]

    d_closes = [d['close'] for d in daily]
    e9d1, e50d1 = ema(d_closes, 9), ema(d_closes, 50)
    d1_trends_all = [trend_at(d_closes, e9d1, e50d1, i, CONFIRM_CANDLES, BUFFER_PCT) for i in range(len(daily))]

    years = (h4[-1]['time'] - h4[0]['time']).days / 365.25
    print(f"\nFréquence de changement de sens sur {years:.1f} ans :")
    print(f"  H4 : {count_flips(h4_trends_all)} flips  ({count_flips(h4_trends_all)/years:.1f} / an)")
    print(f"  D1 : {count_flips(d1_trends_all)} flips  ({count_flips(d1_trends_all)/years:.1f} / an)")

    # --- Backtest trade-by-trade, meme mecanique de sortie, signal H4 vs D1 ---
    trades_h4, _ = simulate_h4_signal(h4, daily, atr_by_date, CONFIRM_CANDLES, BUFFER_PCT)
    trades_d1 = simulate_d1_signal(h4, daily, atr_by_date, CONFIRM_CANDLES, BUFFER_PCT)

    report("Signal H4 (entrée sur croisement EMA9/50 H4)", trades_h4)
    report("Signal D1 (entrée sur croisement EMA9/50 D1, exécution H4)", trades_d1)

    print("\nInterprétation : même mécanique de sortie (stop/cible ATR daily 1:2, hold max 24h) "
          "pour isoler l'effet de la timeframe du SIGNAL. Un t-stat > 2 en valeur absolue "
          "indique un edge statistiquement significatif ; en dessous, indiscernable du hasard "
          "sur cet échantillon. Comparer aussi le nombre de trades généré : moins de trades "
          "avec le D1 = moins d'opportunités captées, à mettre en balance avec un éventuel "
          "gain d'expectancy par trade.")


if __name__ == '__main__':
    main()
