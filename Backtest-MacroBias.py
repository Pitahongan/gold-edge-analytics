#!/usr/bin/env python3
"""
Backtest-MacroBias.py
======================
Teste empiriquement la SEULE brique du systeme qui a assez d'historique
quotidien pour ca : le "Biais Macro (HTF)" (real yields, DXY, yield curve,
XLP/XLY), reproduit ici EXACTEMENT comme evaluateMacroChecklist() dans app.js.

Ce que ca NE teste PAS : momentum M15, RSI, correlations JPY/US10Y intraday,
COT, debasement trade -> data.js ne contient que 5 jours de M15 et l'archive
n'a pas d'historique COT au-dela de la fenetre courante. Pour ces briques,
il faudrait accumuler des snapshots quotidiens de data.js dans le temps
(le dashboard le fait deja via l'upsert quotidien mentionne dans les
memoires -> une fois quelques mois de snapshots accumules, ce script pourra
etre etendu pour les inclure).

Methode : a chaque date t avec assez d'historique TRAILING (pas de
look-ahead : seules les donnees <= t sont utilisees pour calculer le score),
on calcule macroScore(t) exactement comme le dashboard, puis on mesure le
rendement de l'or entre t et t+N jours de bourse (N=5,10,20).

Usage : python3 Backtest-MacroBias.py [chemin/vers/data.js]
"""
import sys
import re
import json
import math
from datetime import datetime, timezone

def load_market_data(path):
    s = open(path, encoding='utf-8').read()
    m = re.match(r'window\.MARKET_DATA\s*=\s*(.*);\s*$', s, re.S)
    if not m:
        raise ValueError("Format de data.js inattendu (préfixe window.MARKET_DATA = ... introuvable).")
    return json.loads(m.group(1))


def ts_to_date(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d')


def build_daily_series(data):
    """Reconstruit une série quotidienne alignée par date, forward-fill,
    identique dans l'esprit à processMarketData() côté app.js."""
    gold = sorted(data['dailyData'].get('Gold', []), key=lambda c: c['time'])
    dxy = sorted(data['dailyData'].get('DXY', []), key=lambda c: c['time'])
    xlp = sorted(data['dailyData'].get('XLP', []), key=lambda c: c['time'])
    xly = sorted(data['dailyData'].get('XLY', []), key=lambda c: c['time'])
    real_yields = {o['date']: o['value'] for o in data.get('realYields', [])}
    yield_curve = {o['date']: o['value'] for o in data.get('yieldCurve', [])}

    by_date = {}
    for c in gold:
        d = ts_to_date(c['time'])
        by_date.setdefault(d, {})['gold'] = c['close']
    for c in dxy:
        d = ts_to_date(c['time'])
        by_date.setdefault(d, {})['dxy'] = c['close']
    for c in xlp:
        d = ts_to_date(c['time'])
        by_date.setdefault(d, {})['xlp'] = c['close']
    for c in xly:
        d = ts_to_date(c['time'])
        by_date.setdefault(d, {})['xly'] = c['close']
    for d, v in real_yields.items():
        by_date.setdefault(d, {})['realYield'] = v
    for d, v in yield_curve.items():
        by_date.setdefault(d, {})['yieldCurve'] = v

    dates = sorted(by_date.keys())
    series = []
    last = {}
    for d in dates:
        day = by_date[d]
        for k in ('gold', 'dxy', 'xlp', 'xly', 'realYield', 'yieldCurve'):
            if k in day:
                last[k] = day[k]
        if 'gold' in last:
            row = {'date': d}
            row.update(last)
            row['xlpXlyRatio'] = (last['xlp'] / last['xly']) if ('xlp' in last and 'xly' in last and last['xly']) else None
            series.append(dict(row))
    return series


def macro_score_at(series, i):
    """Reproduit evaluateMacroChecklist() : real yield, DXY, yield curve,
    XLP/XLY, en n'utilisant QUE series[0..i] (pas de look-ahead)."""
    current = series[i]
    prev_days = series[max(0, i - 9):i + 1]  # 10 derniers jours dont le courant, comme .slice(-10)

    favorable, unfavorable, total = 0, 0, 0

    ry_list = [d['realYield'] for d in prev_days if d.get('realYield') is not None]
    if len(ry_list) >= 2:
        total += 1
        ry_avg = sum(ry_list[:-1]) / len(ry_list[:-1])
        if current.get('realYield') is not None:
            if current['realYield'] <= ry_avg - 0.05:
                favorable += 1
            elif current['realYield'] >= ry_avg + 0.05:
                unfavorable += 1

    dxy_list = [d['dxy'] for d in prev_days if d.get('dxy') is not None]
    if len(dxy_list) >= 5:
        total += 1
        sma = sum(dxy_list) / len(dxy_list)
        if current.get('dxy') is not None:
            if current['dxy'] < sma:
                favorable += 1
            else:
                unfavorable += 1

    if current.get('yieldCurve') is not None:
        total += 1
        if current['yieldCurve'] < 0:
            favorable += 1
        else:
            unfavorable += 1

    xx_list = [d['xlpXlyRatio'] for d in prev_days if d.get('xlpXlyRatio') is not None]
    if len(xx_list) >= 5:
        total += 1
        xx_sma = sum(xx_list) / len(xx_list)
        if current.get('xlpXlyRatio') is not None:
            if current['xlpXlyRatio'] > xx_sma:
                favorable += 1
            else:
                unfavorable += 1

    if total == 0:
        return None
    return ((favorable - unfavorable) / total) * 100


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


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'data.js'
    data = load_market_data(path)
    series = build_daily_series(data)
    n = len(series)
    print(f"Séries quotidiennes alignées : {n} jours ({series[0]['date']} -> {series[-1]['date']})")

    horizons = [5, 10, 20]
    min_lookback = 10  # pour que macro_score_at ait assez d'historique

    rows = []  # (date, score, fwd5, fwd10, fwd20)
    for i in range(min_lookback, n):
        score = macro_score_at(series, i)
        if score is None:
            continue
        fwd = {}
        ok = True
        for h in horizons:
            j = i + h
            if j >= n:
                ok = False
                break
            fwd[h] = (series[j]['gold'] / series[i]['gold'] - 1) * 100
        if not ok:
            continue
        rows.append((series[i]['date'], score, fwd))

    print(f"Observations exploitables (score + rendement forward complet) : {len(rows)}")
    if len(rows) < 30:
        print("ATTENTION : échantillon < 30 observations. Corrélations non fiables statistiquement — juste indicatif.")

    for h in horizons:
        xs = [r[1] for r in rows]
        ys = [r[2][h] for r in rows]
        corr = pearson(xs, ys)
        print(f"\n--- Horizon forward {h}j de bourse ---")
        print(f"Corrélation score macro vs rendement forward : {corr:.3f}" if corr is not None else "Corrélation : n/a (échantillon insuffisant)")

        # Buckets identiques aux seuils du dashboard (>=25 bullish, <=-25 bearish, sinon neutre)
        buckets = {'bullish (>=25)': [], 'neutral (-25..25)': [], 'bearish (<=-25)': []}
        for _, score, fwd in rows:
            if score >= 25:
                buckets['bullish (>=25)'].append(fwd[h])
            elif score <= -25:
                buckets['bearish (<=-25)'].append(fwd[h])
            else:
                buckets['neutral (-25..25)'].append(fwd[h])

        for label, vals in buckets.items():
            if not vals:
                print(f"  {label:22s} n=0")
                continue
            avg = sum(vals) / len(vals)
            win_rate = (sum(1 for v in vals if (v > 0) == ('bullish' in label)) / len(vals) * 100) if 'neutral' not in label else None
            wr_str = f", win-rate directionnel={win_rate:.0f}%" if win_rate is not None else ""
            print(f"  {label:22s} n={len(vals):4d}  rendement moyen={avg:+.2f}%{wr_str}")

    print("\nInterprétation : si le biais macro a un edge réel, le bucket 'bullish' doit"
          " avoir un rendement forward moyen nettement positif et le bucket 'bearish'"
          " nettement négatif, sur les 3 horizons — et pas seulement sur l'échantillon"
          " le plus court. Une corrélation proche de 0 ou instable entre horizons est"
          " un signal pour revoir les poids ou les seuils (25%) dans scoring-config.json,"
          " pas pour les considérer acquis.")


if __name__ == '__main__':
    main()
