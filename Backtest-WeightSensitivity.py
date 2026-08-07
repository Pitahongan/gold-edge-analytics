#!/usr/bin/env python3
"""
Backtest-WeightSensitivity.py
================================
Teste si reduire le poids macroRegime (3 -> 1.5) et augmenter priceActionM15
(2 -> 2.5) ameliore l'edge du score combine, sur la MEME fenetre de 505 jours
que Backtest-MacroBias.py (seule fenetre ou les 5 sous-facteurs macro de
data.js sont disponibles).

Limite assumee : crossAssetConfirm (JPY/US10Y), cotContrarian, dailyRsi et
debasementTrade sont exclus de ce test (pas d'archive historique alignee sur
505 jours pour JPY/US10Y M15 ni pour le COT). Seuls macroRegime et
priceActionM15 -- les deux poids en discussion -- sont compares, poids
identiques dans les deux scenarios pour les autres composantes (donc exclues
sans biaiser la comparaison A/B).

"Momentum M15" n'a que 5 jours d'historique dans data.js -> impossible a
backtester sur 505 jours. On utilise a la place une tendance EMA9/50
quotidienne calculee sur l'export H4 reel du broker XM (gold_h4_export.csv,
resample daily), qui couvre tout l'historique necessaire au warmup EMA50
sans perdre de jours utiles. C'est un PROXY (frequence daily, pas M15) du
meme concept -- tendance de prix suivie -- pas le signal exact du systeme.

Usage : python3 Backtest-WeightSensitivity.py [data.js] [gold_h4_export.csv]
"""
import sys
import re
import csv
import json
import math
from datetime import datetime, timezone


def load_market_data(path):
    s = open(path, encoding='utf-8').read()
    m = re.match(r'window\.MARKET_DATA\s*=\s*(.*);\s*$', s, re.S)
    return json.loads(m.group(1))


def ts_to_date(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d')


def build_macro_daily_series(data):
    gold = sorted(data['dailyData'].get('Gold', []), key=lambda c: c['time'])
    dxy = sorted(data['dailyData'].get('DXY', []), key=lambda c: c['time'])
    oil = sorted(data['dailyData'].get('Oil', []), key=lambda c: c['time'])
    xlp = sorted(data['dailyData'].get('XLP', []), key=lambda c: c['time'])
    xly = sorted(data['dailyData'].get('XLY', []), key=lambda c: c['time'])
    real_yields = {o['date']: o['value'] for o in data.get('realYields', [])}
    yield_curve = {o['date']: o['value'] for o in data.get('yieldCurve', [])}

    by_date = {}
    for c in gold:
        by_date.setdefault(ts_to_date(c['time']), {})['gold'] = c['close']
    for c in dxy:
        by_date.setdefault(ts_to_date(c['time']), {})['dxy'] = c['close']
    for c in oil:
        by_date.setdefault(ts_to_date(c['time']), {})['oil'] = c['close']
    for c in xlp:
        by_date.setdefault(ts_to_date(c['time']), {})['xlp'] = c['close']
    for c in xly:
        by_date.setdefault(ts_to_date(c['time']), {})['xly'] = c['close']
    for d, v in real_yields.items():
        by_date.setdefault(d, {})['realYield'] = v
    for d, v in yield_curve.items():
        by_date.setdefault(d, {})['yieldCurve'] = v

    dates = sorted(by_date.keys())
    series = []
    last = {}
    for d in dates:
        day = by_date[d]
        for k in ('gold', 'dxy', 'oil', 'xlp', 'xly', 'realYield', 'yieldCurve'):
            if k in day:
                last[k] = day[k]
        if 'gold' in last:
            row = {'date': d}
            row.update(last)
            row['goldOil'] = (last['gold'] / last['oil']) if ('oil' in last and last['oil']) else None
            row['xlpXly'] = (last['xlp'] / last['xly']) if ('xlp' in last and 'xly' in last and last['xly']) else None
            series.append(dict(row))
    return series


def macro_score_at(series, i):
    """Reproduit evaluateMacroChecklist() (5 sous-facteurs), sans look-ahead."""
    current = series[i]
    prev_days = series[max(0, i - 9):i + 1]
    all_goldoil = [d['goldOil'] for d in series[:i + 1] if d.get('goldOil') is not None]

    fav, unfav, total = 0, 0, 0

    ry_list = [d['realYield'] for d in prev_days if d.get('realYield') is not None]
    if len(ry_list) >= 2:
        total += 1
        avg = sum(ry_list[:-1]) / len(ry_list[:-1])
        if current.get('realYield') is not None:
            if current['realYield'] <= avg - 0.05:
                fav += 1
            elif current['realYield'] >= avg + 0.05:
                unfav += 1

    dxy_list = [d['dxy'] for d in prev_days if d.get('dxy') is not None]
    if len(dxy_list) >= 5:
        total += 1
        sma = sum(dxy_list) / len(dxy_list)
        if current.get('dxy') is not None:
            fav += 1 if current['dxy'] < sma else 0
            unfav += 1 if current['dxy'] >= sma else 0

    if current.get('yieldCurve') is not None:
        total += 1
        if current['yieldCurve'] < 0:
            fav += 1
        else:
            unfav += 1

    if len(all_goldoil) > 50 and current.get('goldOil'):
        total += 1
        srt = sorted(all_goldoil)
        rank = srt.index(current['goldOil'])
        pct = rank / len(srt) * 100
        if pct < 30:
            fav += 1
        elif pct > 70:
            unfav += 1

    xx_list = [d['xlpXly'] for d in prev_days if d.get('xlpXly') is not None]
    if len(xx_list) >= 5:
        total += 1
        sma = sum(xx_list) / len(xx_list)
        if current.get('xlpXly') is not None:
            fav += 1 if current['xlpXly'] > sma else 0
            unfav += 1 if current['xlpXly'] <= sma else 0

    if total == 0:
        return None
    return ((fav - unfav) / total) * 100


def load_h4_csv(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            t = datetime.strptime(r['time'], '%Y.%m.%d %H:%M')
            rows.append({'time': t, 'close': float(r['close'])})
    rows.sort(key=lambda r: r['time'])
    return rows


def build_daily_trend_from_h4(h4rows, confirm=2, buffer_pct=0.03):
    """EMA9/50 quotidien (close du dernier H4 du jour), meme logique de
    tampon/confirmation que getM15Trend, mais a frequence daily -- proxy du
    momentum M15 faute d'historique M15 suffisant."""
    by_date = {}
    for c in h4rows:
        by_date[c['time'].date()] = c['close']  # dernier close du jour ecrase les precedents (rows triees)
    dates = sorted(by_date.keys())
    closes = [by_date[d] for d in dates]

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

    ema9 = ema(closes, 9)
    ema50 = ema(closes, 50)

    trend_by_date = {}
    for i in range(len(dates)):
        if i - confirm + 1 < 0:
            trend_by_date[dates[i]] = 'neutral'
            continue
        all_bull, all_bear = True, True
        for k in range(i - confirm + 1, i + 1):
            e9, e50, v = ema9[k], ema50[k], closes[k]
            if e9 is None or e50 is None:
                all_bull, all_bear = False, False
                break
            buf = abs(e50) * (buffer_pct / 100)
            bull = e9 > e50 and v > (e50 + buf)
            bear = e9 < e50 and v < (e50 - buf)
            if not bull:
                all_bull = False
            if not bear:
                all_bear = False
        trend_by_date[dates[i]] = 'bullish' if all_bull else ('bearish' if all_bear else 'neutral')
    return trend_by_date


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx == 0 or vy == 0:
        return None
    return cov / math.sqrt(vx * vy)


def evaluate_weights(rows, w_macro, w_price, horizons):
    """rows: list of (date, macroScorePct, trend, fwd{h: pct})"""
    print(f"\n### Poids macroRegime={w_macro} / priceActionM15={w_price} (total testé={w_macro+w_price}) ###")
    for h in horizons:
        xs, ys = [], []
        for date, macro_pct, trend, fwd in rows:
            trend_signal = 100 if trend == 'bullish' else (-100 if trend == 'bearish' else 0)
            combined = (macro_pct / 100) * w_macro + (trend_signal / 100) * w_price
            xs.append(combined)
            ys.append(fwd[h])
        corr = pearson(xs, ys)
        total_w = w_macro + w_price
        cut = total_w * 0.25
        buckets = {'bullish call (>=cut)': [], 'neutre': [], 'bearish call (<=-cut)': []}
        for x, y in zip(xs, ys):
            if x >= cut:
                buckets['bullish call (>=cut)'].append(y)
            elif x <= -cut:
                buckets['bearish call (<=-cut)'].append(y)
            else:
                buckets['neutre'].append(y)
        print(f"  Horizon {h}j : corrélation combinée = {corr:.3f}" if corr is not None else f"  Horizon {h}j : n/a")
        for label, vals in buckets.items():
            if not vals:
                print(f"    {label:24s} n=0")
                continue
            avg = sum(vals) / len(vals)
            wr = (sum(1 for v in vals if (v > 0) == ('bullish' in label)) / len(vals) * 100) if 'neutre' not in label else None
            wr_str = f", win-rate={wr:.0f}%" if wr is not None else ""
            print(f"    {label:24s} n={len(vals):4d}  rendement moyen={avg:+.2f}%{wr_str}")


def main():
    data_path = sys.argv[1] if len(sys.argv) > 1 else 'data.js'
    h4_path = sys.argv[2] if len(sys.argv) > 2 else 'gold_h4_export.csv'

    data = load_market_data(data_path)
    macro_series = build_macro_daily_series(data)
    h4rows = load_h4_csv(h4_path)
    trend_by_date = build_daily_trend_from_h4(h4rows)

    print(f"Jours macro alignés (data.js) : {len(macro_series)} ({macro_series[0]['date']} -> {macro_series[-1]['date']})")
    print(f"Jours de tendance H4->daily (broker XM) : {len(trend_by_date)}")

    horizons = [5, 10, 20]
    min_lookback = 10
    n = len(macro_series)

    rows = []
    for i in range(min_lookback, n):
        macro_pct = macro_score_at(macro_series, i)
        if macro_pct is None:
            continue
        d = datetime.strptime(macro_series[i]['date'], '%Y-%m-%d').date()
        trend = trend_by_date.get(d, 'neutral')
        fwd = {}
        ok = True
        for h in horizons:
            j = i + h
            if j >= n:
                ok = False
                break
            fwd[h] = (macro_series[j]['gold'] / macro_series[i]['gold'] - 1) * 100
        if not ok:
            continue
        rows.append((macro_series[i]['date'], macro_pct, trend, fwd))

    print(f"Observations exploitables : {len(rows)}")

    trend_counts = {}
    for _, _, t, _ in rows:
        trend_counts[t] = trend_counts.get(t, 0) + 1
    print(f"Répartition tendance H4->daily sur la période : {trend_counts}")

    # Scenario A : poids actuels de scoring-config.json
    evaluate_weights(rows, 3.0, 2.0, horizons)
    # Scenario B : poids proposés hier
    evaluate_weights(rows, 1.5, 2.5, horizons)
    # Scenario C : trend seul (macro à 0), pour référence
    evaluate_weights(rows, 0.0, 1.0, horizons)
    # Scenario D : macro seul (trend à 0), = Backtest-MacroBias.py, pour référence
    evaluate_weights(rows, 1.0, 0.0, horizons)

    print("\nInterprétation : comparer la corrélation et le win-rate directionnel du bucket "
          "bullish/bearish entre scénarios A (poids actuels) et B (poids proposés hier). "
          "Si B améliore la corrélation ET rend le win-rate bearish plus proche de 50%+ "
          "sans dégrader le bullish, la réduction du poids macro est justifiée empiriquement, "
          "pas seulement par intuition. Rappel : le signal 'tendance' ici est un PROXY daily "
          "(EMA9/50 sur clôtures H4), pas le vrai momentum M15 du système — les valeurs "
          "absolues ne sont pas transposables telles quelles, seule la comparaison A vs B "
          "à méthode égale est interprétable.")


if __name__ == '__main__':
    main()
