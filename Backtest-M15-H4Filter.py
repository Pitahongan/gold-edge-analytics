#!/usr/bin/env python3
"""
Backtest-M15-H4Filter.py
==========================
LE test qu'on voulait depuis le debut : le vrai signal Momentum M15 (celui
qui tourne en prod, getM15Trend()/Get-StableTrend, EMA9/50 + tampon +
confirmation 2 bougies) sur de vraies donnees M15 XM (gold_m15_export.csv,
~4.25 ans, 2022-2026 -- plus les 5 jours habituels de data.js), compare
AVEC et SANS filtre de confirmation H4 (le trade M15 n'est pris que si le
H4 est d'accord sur la direction).

Meme mecanique de sortie que les tests precedents : stop = 1x ATR14
quotidien, cible = 2x ATR14 quotidien, hold max 24h (96 bougies M15).
Seule variable testee : filtre H4 actif ou non.

Usage : python3 Backtest-M15-H4Filter.py [gold_m15_export.csv] [gold_h4_export.csv]
"""
import sys
import csv
from datetime import datetime, timedelta

CONFIRM_CANDLES = 2
BUFFER_PCT = 0.03
ATR_PERIOD = 14
MAX_HOLD_BARS_M15 = 96   # 24h en M15
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


def trend_series(closes, confirm, buffer_pct):
    e9, e50 = ema(closes, 9), ema(closes, 50)
    out = [None] * len(closes)
    for i in range(len(closes)):
        if i - confirm + 1 < 0 or e9[i] is None:
            out[i] = 'neutral'
            continue
        all_bull, all_bear = True, True
        for k in range(i - confirm + 1, i + 1):
            e9k, e50k, v = e9[k], e50[k], closes[k]
            if e9k is None or e50k is None:
                all_bull, all_bear = False, False
                break
            buf = abs(e50k) * (buffer_pct / 100)
            bull = e9k > e50k and v > (e50k + buf)
            bear = e9k < e50k and v < (e50k - buf)
            if not bull:
                all_bull = False
            if not bear:
                all_bear = False
        out[i] = 'bullish' if all_bull else ('bearish' if all_bear else 'neutral')
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


def build_h4_trend_lookup(h4, confirm, buffer_pct):
    """Retourne une liste triee de (close_time, trend) : le trend H4 devient
    valide/consultable a partir de la CLOTURE de la bougie H4 (open_time+4h),
    pas avant -- pas de look-ahead."""
    closes = [c['close'] for c in h4]
    trends = trend_series(closes, confirm, buffer_pct)
    events = []
    for i in range(len(h4)):
        close_time = h4[i]['time'] + timedelta(hours=4)
        events.append((close_time, trends[i]))
    events.sort(key=lambda e: e[0])
    return events


def build_d1_trend_lookup(daily, confirm, buffer_pct):
    """Meme principe que build_h4_trend_lookup mais sur les bougies quotidiennes
    (construites par build_daily_bars a partir du H4) : le trend D1 devient
    valide a partir de la cloture du jour (minuit le lendemain), pas avant."""
    closes = [d['close'] for d in daily]
    trends = trend_series(closes, confirm, buffer_pct)
    events = []
    for i in range(len(daily)):
        close_time = datetime.combine(daily[i]['date'], datetime.min.time()) + timedelta(days=1)
        events.append((close_time, trends[i]))
    events.sort(key=lambda e: e[0])
    return events


def simulate(m15, m15_trends, filter_events, daily, atr_by_date, use_filter, filter2_events=None):
    trades = []
    n = len(m15)
    f_ptr = 0
    current_filter_trend = 'neutral'
    f2_ptr = 0
    current_filter2_trend = 'neutral'
    i = 50 + CONFIRM_CANDLES

    while f_ptr < len(filter_events) and filter_events[f_ptr][0] <= m15[i]['time']:
        current_filter_trend = filter_events[f_ptr][1]
        f_ptr += 1
    if filter2_events:
        while f2_ptr < len(filter2_events) and filter2_events[f2_ptr][0] <= m15[i]['time']:
            current_filter2_trend = filter2_events[f2_ptr][1]
            f2_ptr += 1

    while i < n - 1:
        while f_ptr < len(filter_events) and filter_events[f_ptr][0] <= m15[i]['time']:
            current_filter_trend = filter_events[f_ptr][1]
            f_ptr += 1
        if filter2_events:
            while f2_ptr < len(filter2_events) and filter2_events[f2_ptr][0] <= m15[i]['time']:
                current_filter2_trend = filter2_events[f2_ptr][1]
                f2_ptr += 1

        m15_trend = m15_trends[i]
        filter_ok_bull = (not use_filter) or (current_filter_trend == 'bullish' and (not filter2_events or current_filter2_trend == 'bullish'))
        filter_ok_bear = (not use_filter) or (current_filter_trend == 'bearish' and (not filter2_events or current_filter2_trend == 'bearish'))
        signal = None
        if m15_trend == 'bullish' and filter_ok_bull:
            signal = 'buy'
        elif m15_trend == 'bearish' and filter_ok_bear:
            signal = 'sell'

        if signal:
            cur_date = m15[i]['time'].date()
            atr_today = None
            for d in daily:
                if d['date'] <= cur_date and atr_by_date.get(d['date']) is not None:
                    atr_today = atr_by_date[d['date']]
                elif d['date'] > cur_date:
                    break
            if atr_today:
                entry_idx = i + 1
                entry = m15[entry_idx]['open']
                sl = entry - atr_today if signal == 'buy' else entry + atr_today
                tp = entry + 2 * atr_today if signal == 'buy' else entry - 2 * atr_today
                last_j = min(entry_idx + MAX_HOLD_BARS_M15, n - 1)
                exit_price, reason = None, None
                for j in range(entry_idx, last_j + 1):
                    bar = m15[j]
                    if signal == 'buy':
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
                    exit_price, reason = m15[last_j]['close'], 'TIME'
                pnl = (exit_price - entry if signal == 'buy' else entry - exit_price) - SPREAD_COST
                trades.append({'time': m15[entry_idx]['time'], 'direction': signal, 'pnl': pnl, 'r': pnl / atr_today, 'reason': reason})
                i = last_j + 1
                continue
        i += 1
    return trades


def analyze_streaks(trades):
    """Trades deja tries par ordre chronologique (simulate() les ajoute dans
    cet ordre). Calcule les series consecutives de SL (uniquement des sorties
    reason=='SL' dos-a-dos) et, separement, les series de pertes en general
    (pnl<=0 quelle que soit la raison de sortie) -- une perte TIME juste apres
    une perte SL casse la serie SL mais alourdit quand meme le drawdown reel."""
    max_sl, cur_sl = 0, 0
    sl_dist = {}
    max_loss, cur_loss = 0, 0
    loss_dist = {}
    for t in trades:
        if t['reason'] == 'SL':
            cur_sl += 1
        else:
            if cur_sl > 0:
                sl_dist[cur_sl] = sl_dist.get(cur_sl, 0) + 1
            max_sl = max(max_sl, cur_sl)
            cur_sl = 0
        if t['pnl'] <= 0:
            cur_loss += 1
        else:
            if cur_loss > 0:
                loss_dist[cur_loss] = loss_dist.get(cur_loss, 0) + 1
            max_loss = max(max_loss, cur_loss)
            cur_loss = 0
    if cur_sl > 0:
        sl_dist[cur_sl] = sl_dist.get(cur_sl, 0) + 1
        max_sl = max(max_sl, cur_sl)
    if cur_loss > 0:
        loss_dist[cur_loss] = loss_dist.get(cur_loss, 0) + 1
        max_loss = max(max_loss, cur_loss)
    return max_sl, sl_dist, max_loss, loss_dist


def report(name, trades, years):
    n = len(trades)
    print(f"\n=== {name} ===")
    print(f"  Trades : {n}  ({n/years:.0f}/an)")
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
        print(f"    {reason:5s} n={len(ts):6d} ({len(ts)/n*100:.0f}%)  avg_r={sum(x['r'] for x in ts)/len(ts):+.2f}")
    for d in ('buy', 'sell'):
        ts = [t for t in trades if t['direction'] == d]
        if ts:
            print(f"    {d:5s} n={len(ts):6d}  expectancy={sum(x['r'] for x in ts)/len(ts):+.3f}R  win-rate={sum(1 for x in ts if x['pnl']>0)/len(ts)*100:.0f}%")
    buckets = {}
    for t in trades:
        key = t['time'].year
        buckets.setdefault(key, []).append(t)
    print("  Par année :")
    for key in sorted(buckets.keys()):
        ts = buckets[key]
        wr_y = sum(1 for x in ts if x['pnl'] > 0) / len(ts) * 100
        print(f"    {key}  n={len(ts):6d}  expectancy={sum(x['r'] for x in ts)/len(ts):+.3f}R  win-rate={wr_y:.0f}%")

    max_sl, sl_dist, max_loss, loss_dist = analyze_streaks(trades)
    print(f"  Plus longue série de SL consécutifs        : {max_sl}")
    if sl_dist:
        detail = ', '.join(f"{length}x{count}" for length, count in sorted(sl_dist.items()))
        print(f"    (répartition longueur:occurrences -> {detail})")
    print(f"  Plus longue série de pertes consécutives    : {max_loss}  (SL ou TIME en perte, sans interruption par un trade gagnant)")
    if loss_dist:
        detail = ', '.join(f"{length}x{count}" for length, count in sorted(loss_dist.items()))
        print(f"    (répartition longueur:occurrences -> {detail})")
    return max_sl, max_loss


def main():
    m15_path = sys.argv[1] if len(sys.argv) > 1 else 'gold_m15_export.csv'
    h4_path = sys.argv[2] if len(sys.argv) > 2 else 'gold_h4_export.csv'

    m15 = load_csv(m15_path)
    h4 = load_csv(h4_path)
    print(f"M15 : {len(m15)} bougies ({m15[0]['time']} -> {m15[-1]['time']})")
    print(f"H4  : {len(h4)} bougies ({h4[0]['time']} -> {h4[-1]['time']})")

    years = (m15[-1]['time'] - m15[0]['time']).days / 365.25

    daily = build_daily_bars(h4)
    atr14 = atr_wilder(daily, ATR_PERIOD)
    atr_by_date = {daily[i]['date']: atr14[i] for i in range(len(daily))}

    m15_closes = [c['close'] for c in m15]
    m15_trends = trend_series(m15_closes, CONFIRM_CANDLES, BUFFER_PCT)

    trend_counts = {}
    for t in m15_trends:
        trend_counts[t] = trend_counts.get(t, 0) + 1
    print(f"Répartition M15 sur la période : {trend_counts}")

    h4_events = build_h4_trend_lookup(h4, CONFIRM_CANDLES, BUFFER_PCT)
    d1_events = build_d1_trend_lookup(daily, CONFIRM_CANDLES, BUFFER_PCT)

    print("\nSimulation en cours (peut prendre quelques dizaines de secondes)...")
    trades_baseline = simulate(m15, m15_trends, h4_events, daily, atr_by_date, use_filter=False)
    trades_h4 = simulate(m15, m15_trends, h4_events, daily, atr_by_date, use_filter=True)
    trades_d1 = simulate(m15, m15_trends, d1_events, daily, atr_by_date, use_filter=True)
    trades_both = simulate(m15, m15_trends, h4_events, daily, atr_by_date, use_filter=True, filter2_events=d1_events)

    results = []
    for label, trades in [
        ("M15 seul", trades_baseline),
        ("M15 + H4", trades_h4),
        ("M15 + D1", trades_d1),
        ("M15 + H4 + D1", trades_both),
    ]:
        max_sl, max_loss = report(label, trades, years)
        n = len(trades)
        avg_r = sum(t['r'] for t in trades) / n if n else 0
        wr = sum(1 for t in trades if t['pnl'] > 0) / n * 100 if n else 0
        results.append((label, n, wr, avg_r, max_sl, max_loss))

    print("\n" + "=" * 78)
    print("TABLEAU RÉCAPITULATIF — séries consécutives de stop loss")
    print("=" * 78)
    print(f"{'Scénario':<16}{'Trades':>8}{'Win%':>7}{'Expectancy':>12}{'Max SL consec.':>16}{'Max pertes consec.':>20}")
    for label, n, wr, avg_r, max_sl, max_loss in results:
        print(f"{label:<16}{n:>8}{wr:>6.1f}%{avg_r:>+11.3f}R{max_sl:>15d}{max_loss:>20d}")

    print("\nInterprétation : comparer expectancy, t-stat et surtout le taux de SL "
          "(sorties en perte immédiate = signal de bruit qui n'aurait jamais dû être pris) "
          "entre les deux scénarios, sur le VRAI signal M15 du système en prod, sur "
          f"{years:.1f} ans de données M15 réelles XM (pas un proxy).")


if __name__ == '__main__':
    main()
