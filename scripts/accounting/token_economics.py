"""Reproducible API-equivalent token valuation. No inference, funding or billing writes."""
import argparse
import csv
import datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import urllib.request

from normalize import parse_snapshot

ALIASES = {
    'gpt-6-astra': 'openai/gpt-6-astra',
    'claude-fable-5-1': 'anthropic/claude-fable-5.1',
    'mistral-medium-3.5': 'mistralai/mistral-medium-3-5',
    'gemini-3.5-flash': 'google/gemini-3.5-flash',
    'grok-4.6': 'x-ai/grok-4.6',
    'muse-spark-1.3': 'meta/muse-spark-1.3',
}
D = lambda value: Decimal(str(value))


def calculate(row, pricing):
    """Value reported categories; retain missing categories and ambiguous tiers explicitly."""
    t = row['tokens']
    if any(t.get(k) is None for k in ['uncachedInput', 'cacheRead', 'output']):
        return {'status': 'unknown', 'reason': 'missing_input_cache_or_output'}
    flags = []
    if t.get('cacheWrite') is None:
        flags.append('cache_creation_unreported_excluded')
    if t['cacheRead'] and 'input_cache_read' not in pricing:
        flags.append('no_advertised_cache_discount_standard_input_rate_used')

    def at_rate(rates):
        prompt = D(rates['prompt'])
        result = D(t['uncachedInput']) * prompt
        result += D(t['cacheRead']) * D(rates.get('input_cache_read', rates['prompt']))
        result += D(t['output']) * D(rates['completion'])
        writes = t.get('cacheWrite')
        if writes:
            ttl = (row.get('rawUsage') or {}).get('cache_creation')
            if ttl and 'input_cache_write_1h' in rates:
                one = ttl.get('ephemeral_1h_input_tokens')
                five = ttl.get('ephemeral_5m_input_tokens')
                if one is None or five is None or one + five != writes:
                    raise ValueError('cache_creation_ttl_does_not_reconcile')
                result += D(one) * D(rates['input_cache_write_1h'])
                result += D(five) * D(rates['input_cache_write'])
            elif 'input_cache_write' in rates:
                if 'input_cache_write_1h' in rates:
                    raise ValueError('cache_creation_ttl_unknown')
                result += D(writes) * D(rates['input_cache_write'])
            else:
                raise ValueError('cache_creation_rate_missing')
        return result

    prompt_tokens = sum(t.get(k) or 0 for k in ['uncachedInput', 'cacheRead', 'cacheWrite'])
    tiers = [pricing] + [{**pricing, **o} for o in pricing.get('overrides', [])]
    if row['granularity'] == 'call':
        # min_prompt_tokens is an inclusive lower bound in the captured catalog.
        eligible = [r for r in tiers if r.get('min_prompt_tokens', 0) <= prompt_tokens]
        candidates = [max(eligible, key=lambda r: r.get('min_prompt_tokens', 0))]
    else:
        # Aggregate usage cannot reveal each constituent request's context tier.
        candidates = [r for r in tiers if r.get('min_prompt_tokens', 0) <= prompt_tokens]
        if len(candidates) > 1:
            flags.append('aggregate_context_tier_range')
    try:
        costs = [at_rate(r) for r in candidates]
    except (ValueError, KeyError) as error:
        return {'status': 'unknown', 'reason': str(error)}
    return {'status': 'estimated', 'lowUsd': str(min(costs)), 'highUsd': str(max(costs)), 'flags': flags}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot', type=Path, required=True)
    p.add_argument('--tariffs', type=Path, required=True)
    p.add_argument('--refresh-tariffs', action='store_true')
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    if args.refresh_tariffs:
        with urllib.request.urlopen('https://openrouter.ai/api/v1/models', timeout=30) as response:
            catalog = json.load(response)
        catalog['retrievedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        args.tariffs.parent.mkdir(parents=True, exist_ok=True)
        args.tariffs.write_text(json.dumps(catalog, indent=2) + '\n')
    tariff_bytes = args.tariffs.read_bytes()
    catalog = json.loads(tariff_bytes)
    models = {r['id']: r for r in catalog['data']}
    manifest, rows, _ = parse_snapshot(args.snapshot)
    session_models = {}
    for r in rows:
        if r['model']:
            session_models.setdefault((r['franchiseId'], r['sessionId']), set()).add(r['model'])
    results = []
    for r in rows:
        model = r['model']
        inferred = False
        same_session = session_models.get((r['franchiseId'], r['sessionId']), set())
        if not model and len(same_session) == 1:
            model = next(iter(same_session))
            inferred = True
        slug = ALIASES.get(model, model)
        result = calculate(r, models[slug]['pricing']) if slug in models else {'status': 'unknown', 'reason': 'unmapped_model'}
        results.append({**r, 'referenceModel': slug, 'modelResolvedFromSameSession': inferred, **result})
    summary = []
    for co in sorted(set(r['franchiseId'] for r in results)):
        rs = [r for r in results if r['franchiseId'] == co]
        known = [r for r in rs if r['status'] == 'estimated']
        low = sum((D(r['lowUsd']) for r in known), D(0))
        high = sum((D(r['highUsd']) for r in known), D(0))
        dates = [r['at'] for r in rs if r['at']]
        summary.append({'franchise': co, 'lowUsd': str(low), 'highUsd': str(high),
            'pricedRecords': len(known), 'unknownRecords': len(rs)-len(known),
            'firstRecordAt': min(dates), 'lastRecordAt': max(dates),
            'models': sorted(set(r['referenceModel'] or 'UNKNOWN' for r in rs)),
            'flags': sorted(set(f for r in known for f in r['flags'])),
            'modelResolutionsFromSameSession': sum(r['modelResolvedFromSameSession'] for r in rs)})
    output = {'method': 'recorded-inference-openrouter-reference-v1',
        'scope': 'API-equivalent estimate of retained native inference usage; not cash billing, paid tools, cache storage or cap enforcement',
        'capturedAt': manifest['capturedAt'], 'tariffsRetrievedAt': catalog.get('retrievedAt'),
        'tariffsSha256': hashlib.sha256(tariff_bytes).hexdigest(),
        'snapshotManifestSha256': hashlib.sha256((args.snapshot/'manifest.json').read_bytes()).hexdigest(),
        'franchises': summary}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'summary.json').write_text(json.dumps(output, indent=2)+'\n')
    (args.out/'records.json').write_text(json.dumps(results, indent=2)+'\n')
    with (args.out/'summary.csv').open('w') as file:
        writer = csv.DictWriter(file, fieldnames=list(summary[0]))
        writer.writeheader()
        writer.writerows(summary)
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
