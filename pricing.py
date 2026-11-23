"""Local model catalog and its command-line editor."""
import argparse
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile


CATALOG = Path(__file__).with_name('pricing.json')
MODEL_ID = re.compile(r'[a-z0-9][a-z0-9._-]{0,79}')
RESERVED = {'unknown', 'mixed', 'codex-auto-review'}
MAX_MODELS = 256
TIERS = {'standard', 'fast', 'flex', 'batch', 'ultrafast'}


def valid_model(model):
    return MODEL_ID.fullmatch(model) and model not in RESERVED


def valid_rate(value):
    return type(value) in (float, int) and 0 <= value <= 100_000


def load_catalog(path):
    catalog = json.loads(path.read_text())
    models = catalog.get('models') if isinstance(catalog, dict) else None
    if not isinstance(models, dict) or len(models) > MAX_MODELS:
        raise ValueError(f'Expected a models object with at most {MAX_MODELS} entries')
    for model, rates in models.items():
        if not valid_model(model) or not isinstance(rates, dict):
            raise ValueError(f'Invalid model entry: {model!r}')
        if any(not valid_rate(rates.get(field)) for field in ('input', 'cached', 'output')):
            raise ValueError(f'{model} needs numeric input, cached and output rates')
        if 'write' in rates and not valid_rate(rates['write']):
            raise ValueError(f'{model} has an invalid cache-write rate')
        if 'long_threshold' in rates:
            threshold = rates['long_threshold']
            if (type(threshold) is not int or threshold <= 0
                    or not all(valid_rate(rates.get(field)) for field in ('long_input', 'long_output'))
                    or ('long_cached' in rates and not valid_rate(rates['long_cached']))):
                raise ValueError(f'{model} has invalid long-context pricing')
        tiers = rates.get('tiers', {})
        if not isinstance(tiers, dict) or any(key not in TIERS or not valid_rate(rate) for key, rate in tiers.items()):
            raise ValueError(f'{model} has invalid tier multipliers')
        if 'ultrafast_promo' in rates:
            promo = rates['ultrafast_promo']
            try:
                until = datetime.fromisoformat(promo['until'].replace('Z', '+00:00'))
                valid_promo = until.tzinfo is not None and valid_rate(promo['multiplier'])
            except (AttributeError, KeyError, TypeError, ValueError):
                valid_promo = False
            if not valid_promo or 'ultrafast' not in tiers:
                raise ValueError(f'{model} has invalid Ultrafast promotional pricing')
    return catalog


def rate_argument(raw):
    try:
        rate = float(raw)
    except ValueError:
        rate = None
    if not valid_rate(rate):
        raise argparse.ArgumentTypeError('expected a USD rate from 0 to 100000')
    return rate


def main():
    parser = argparse.ArgumentParser(description='Add or update a Meter model. Rates are in USD per 1M tokens.')
    parser.add_argument('model', help='exact model ID from Codex')
    parser.add_argument('input', type=rate_argument, help='input token rate')
    parser.add_argument('cached', type=rate_argument, help='cached input token rate')
    parser.add_argument('output', type=rate_argument, help='output token rate')
    parser.add_argument('--cache-write', type=rate_argument, help='cache-write token rate, if published')
    parser.add_argument('--file', type=Path, default=CATALOG, help='catalog used by this Meter installation')
    args = parser.parse_args()
    if not valid_model(args.model):
        parser.error('use a model ID of 1–80 lowercase letters, digits, dots, underscores or hyphens')

    destination = args.file.resolve()
    # Lock the directory so concurrent updates still serialize across atomic replacements.
    try:
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(directory, fcntl.LOCK_EX)
            catalog = load_catalog(destination)
            models = catalog['models']
            if args.model not in models:
                if len(models) == MAX_MODELS:
                    raise ValueError('Model catalog is full')
                models[args.model] = {'tiers': {'standard': 1}}
            rates = models[args.model]
            rates.update(input=args.input, cached=args.cached, output=args.output)
            if args.cache_write is not None:
                rates['write'] = args.cache_write
            with NamedTemporaryFile(mode='w', dir=destination.parent, delete=False) as temp:
                temporary = Path(temp.name)
                try:
                    json.dump(catalog, temp, indent=2, allow_nan=False)
                    temp.write('\n')
                    temp.flush()
                    os.fchmod(temp.fileno(), destination.stat().st_mode & 0o777)
                    os.fsync(temp.fileno())
                    os.replace(temporary, destination)
                finally:
                    temporary.unlink(missing_ok=True)
        finally:
            os.close(directory)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f'Saved {args.model} in {destination}')


if __name__ == '__main__':
    main()
