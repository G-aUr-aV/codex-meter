"""Passive numeric accounting. No network code and no raw-content persistence."""
import argparse
from collections import deque
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import stat
import time
from zoneinfo import ZoneInfo

FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
          'output_tokens', 'reasoning_output_tokens', 'total_tokens')
MAX_LINE = 4 * 1024 * 1024
MAX_SCAN = 16 * 1024 * 1024
MAX_USAGE_EVENTS = 10000
TIERS = {'default': 'standard', 'standard': 'standard', 'priority': 'fast',
         'fast': 'fast', 'flex': 'flex', 'batch': 'batch', 'ultrafast': 'ultrafast'}
EFFORTS = {'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'}


def counters(value):
    if not isinstance(value, dict):
        return None
    out = {}
    for key in FIELDS:
        n = value.get(key, 0)
        if type(n) is not int or not 0 <= n <= 10**12:
            return None
        out[key] = n
    if (out['cached_input_tokens'] + out['cache_write_input_tokens'] > out['input_tokens']
            or out['reasoning_output_tokens'] > out['output_tokens']
            or out['total_tokens'] != out['input_tokens'] + out['output_tokens']):
        return None
    return out


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        n = parsed.timestamp()
        return n if 1577836800 <= n <= time.time() + 86400 else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def price(tokens, model, tier, rates, legacy=False):
    row = rates['models'].get(model)
    # Unknown routing aliases and legacy batches must never acquire invented prices.
    if not row or tier not in {'standard', 'fast', 'flex', 'batch', 'ultrafast'} or legacy:
        return None
    if tier == 'ultrafast' and model != 'gpt-6.1-sol':
        return None
    multiplier = {'standard': 1, 'fast': 2, 'flex': .5, 'batch': .5, 'ultrafast': 6}[tier]
    long = tokens['input_tokens'] > row['long_threshold']
    im = row['long_input'] if long else 1
    cm = row.get('long_cached', im) if long else 1
    om = row['long_output'] if long else 1
    plain = tokens['input_tokens'] - tokens['cached_input_tokens'] - tokens['cache_write_input_tokens']
    return round(multiplier * (plain * row['input'] * im
                 + tokens['cached_input_tokens'] * row['cached'] * cm
                 + tokens['cache_write_input_tokens'] * row['write'] * im
                 + tokens['output_tokens'] * row['output'] * om) / 1_000_000, 10)


def empty():
    return {**{k: 0 for k in FIELDS}, 'requests': 0, 'pricedRequests': 0,
            'unpricedRequests': 0, 'costUSD': 0.0, 'legacyRequests': 0}


def add(bucket, row):
    for k in FIELDS:
        bucket[k] += row[k]
    bucket['requests'] += 1
    bucket['legacyRequests'] += row['kind'] == 'legacy'
    if row['cost'] is None:
        bucket['unpricedRequests'] += 1
    else:
        bucket['pricedRequests'] += 1
        bucket['costUSD'] = round(bucket['costUSD'] + row['cost'], 10)


class Collector:
    def __init__(self, roots, state, output, pricing, timezone='Asia/Kolkata'):
        self.roots = [Path(p) for p in roots]
        self.state_dir = Path(state)
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.output = Path(output)
        self.output.parent.mkdir(parents=True, exist_ok=True)
        secret = self.state_dir / 'identity.key'
        if not secret.exists():
            fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(secrets.token_bytes(32))
        self.key = secret.read_bytes()
        self.rates = json.loads(Path(pricing).read_text())
        self.zone = ZoneInfo(timezone)
        self.db = sqlite3.connect(self.state_dir / 'ledger.sqlite')
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, cursor INTEGER, state TEXT);
            CREATE TABLE IF NOT EXISTS events (
              id TEXT PRIMARY KEY, sid TEXT, tid TEXT, ts REAL, model TEXT, tier TEXT,
              effort TEXT, role TEXT, kind TEXT, input_tokens INTEGER,
              cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
              output_tokens INTEGER, reasoning_output_tokens INTEGER, total_tokens INTEGER,
              cost REAL);
            CREATE INDEX IF NOT EXISTS event_turn ON events(sid,tid,kind);
            CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, started REAL, ended REAL);
            CREATE TABLE IF NOT EXISTS tools (id TEXT PRIMARY KEY, tid TEXT);
        ''')

    def ident(self, value):
        return hmac.new(self.key, str(value).encode(), hashlib.sha256).hexdigest()[:24]

    def initial(self, fkey):
        return {'sid': fkey, 'tid': self.ident(fkey + 'unassigned'), 'model': 'unknown',
                'tier': 'unknown', 'effort': 'unknown', 'role': 'Codex', 'created': 0,
                'own': False, 'has_meta': False, 'total': {k: 0 for k in FIELDS}, 'invalid': 0,
                'oversized': 0, 'resets': 0, 'dropping': False}

    def safe_files(self):
        # All traversal is fd-relative; symlink components and non-regular files are rejected.
        for root in self.roots:
            try:
                fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except OSError:
                continue
            try:
                yield from self.walk(fd, 0)
            finally:
                os.close(fd)

    def walk(self, fd, depth):
        if depth > 6:
            return
        with os.scandir(fd) as scan:
            entries = sorted(scan, key=lambda e: e.name)
        for e in entries:
            if e.is_symlink():
                continue
            if e.is_dir(follow_symlinks=False):
                try:
                    sub = os.open(e.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except OSError:
                    continue
                try:
                    yield from self.walk(sub, depth + 1)
                finally:
                    os.close(sub)
            elif e.name.endswith('.jsonl') and e.is_file(follow_symlinks=False):
                try:
                    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_NOATIME', 0)
                    source = os.open(e.name, flags, dir_fd=fd)
                    s = os.fstat(source)
                    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                        os.close(source)
                        continue
                except OSError:
                    continue
                yield source, s
            elif e.name.endswith('.jsonl.zst') and e.is_file(follow_symlinks=False):
                self.unsupported_files += 1

    def event(self, r, state):
        p = r.get('payload')
        if not isinstance(p, dict):
            return
        typ = r.get('type')
        event = p.get('type') if typ == 'event_msg' else typ
        ts = timestamp(r.get('timestamp'))
        if typ == 'session_meta':
            sid = p.get('id') or p.get('session_id')
            if not isinstance(sid, str) or len(sid) > 200:
                return
            state['sid'] = self.ident('session:' + sid)
            state['has_meta'] = True
            state['created'] = timestamp(p.get('timestamp')) or ts or 0
            state['tid'] = self.ident(state['sid'] + ':unassigned')
            state['role'] = 'Agent' if isinstance(p.get('source'), dict) else 'Codex'
            state['own'] = False
            return
        if not state.get('has_meta'):
            return
        if ts is None:
            return
        if event == 'task_started':
            # Parent history prefixes have timestamps older than the child's session creation.
            if ts + .001 < state['created']:
                return
            state['own'] = True
            tid = p.get('turn_id')
            if isinstance(tid, str) and len(tid) <= 200:
                state['tid'] = self.ident(state['sid'] + ':' + tid)
            self.db.execute('INSERT INTO turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET started=min(started,excluded.started)',
                            (state['tid'], ts, ts))
        if typ == 'turn_context' and ts + .001 >= state['created']:
            state['own'] = True
            if isinstance(p.get('turn_id'), str):
                state['tid'] = self.ident(state['sid'] + ':' + p['turn_id'][:200])
            model = p.get('model')
            state['model'] = model if model in self.rates['models'] or model == 'codex-auto-review' else 'unknown'
            state['effort'] = p.get('effort') if p.get('effort') in EFFORTS else 'unknown'
            if state['model'] == 'codex-auto-review':
                state['role'] = 'Review'
        if event == 'thread_settings_applied' and state['own']:
            settings = p.get('thread_settings') or {}
            state['tier'] = TIERS.get(settings.get('service_tier'), 'unknown')
        if event == 'token_count':
            info = p.get('info') or {}
            current = counters(info.get('total_token_usage'))
            if not current:
                state['invalid'] += 1
                return
            previous = state['total']
            state['total'] = current
            if not state['own'] or ts + .001 < state['created']:
                return
            if current == previous:
                return
            if any(current[k] < previous[k] for k in FIELDS):
                state['resets'] += 1
                return  # Fail conservatively on ambiguous resets; structured records still count.
            delta = counters({k: current[k] - previous[k] for k in FIELDS})
            if not delta or not delta['total_tokens']:
                return
            event_id = self.ident('legacy:' + state['sid'] + ':' + str(ts) + ':' + json.dumps(current, sort_keys=True))
            self.insert(event_id, state, ts, delta, 'legacy', legacy=True)
        if event == 'token_usage_record' and state['own'] and ts + .001 >= state['created']:
            usage = counters(p.get('usage'))
            rid = p.get('response_id')
            if not usage or not isinstance(rid, str) or not 1 <= len(rid) <= 300:
                state['invalid'] += 1
                return
            tid = p.get('turn_id')
            active = dict(state)
            if isinstance(tid, str):
                active['tid'] = self.ident(state['sid'] + ':' + tid[:200])
            self.insert(self.ident('response:' + rid), active, ts, usage, 'request')
        if state['own']:
            self.db.execute('INSERT INTO turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET ended=max(ended,excluded.ended)',
                            (state['tid'], ts, ts))
            item = p if typ in {'response_item', 'item_completed'} else None
            if isinstance(item, dict) and isinstance(item.get('item'), dict):
                item = item['item']
            tool = typ in {'function_call', 'custom_tool_call'} or (item and item.get('type') in {'function_call', 'custom_tool_call'})
            if tool:
                call = (item or p).get('call_id') or (item or p).get('id') or str(ts)
                self.db.execute('INSERT OR IGNORE INTO tools VALUES(?,?)',
                                (self.ident(state['sid'] + ':tool:' + str(call)[:300]), state['tid']))

    def insert(self, eid, state, ts, usage, kind, legacy=False):
        cost = price(usage, state['model'], state['tier'], self.rates, legacy)
        self.db.execute('INSERT OR IGNORE INTO events VALUES(' + ','.join('?' for _ in range(16)) + ')',
                        (eid, state['sid'], state['tid'], ts, state['model'], state['tier'],
                         state['effort'], state['role'], kind, *(usage[k] for k in FIELDS), cost))

    def scan(self):
        start = time.monotonic()
        self.unsupported_files = 0
        remaining = MAX_SCAN
        files = lag = 0
        for fd, info in self.safe_files():
            files += 1
            key = self.ident(f'{info.st_dev}:{info.st_ino}')
            previous = self.db.execute('SELECT cursor,state FROM files WHERE id=?', (key,)).fetchone()
            cursor = previous['cursor'] if previous else 0
            state = json.loads(previous['state']) if previous else self.initial(key)
            if info.st_size < cursor:
                cursor, state = 0, self.initial(key)
                state['resets'] = 1
            try:
                with os.fdopen(fd, 'rb') as source:
                    source.seek(cursor)
                    allowance = min(2 * 1024 * 1024, remaining)
                    consumed = 0
                    while allowance > consumed:
                        offset = source.tell()
                        line = source.readline(MAX_LINE + 1)
                        if not line:
                            break
                        if state['dropping']:
                            cursor = source.tell()
                            state['dropping'] = not line.endswith(b'\n')
                        elif len(line) > MAX_LINE:
                            state['oversized'] += 1
                            state['dropping'] = not line.endswith(b'\n')
                            cursor = source.tell()
                        elif not line.endswith(b'\n'):
                            break  # An active writer's incomplete last line is retried next scan.
                        else:
                            try:
                                row = json.loads(line)
                                if isinstance(row, dict):
                                    self.event(row, state)
                            except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
                                state['invalid'] += 1
                            cursor = source.tell()
                        consumed += source.tell() - offset
                    remaining = max(0, remaining - consumed)
            except OSError:
                state['invalid'] += 1
            lag += max(0, info.st_size - cursor)
            self.db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?)', (key, cursor, json.dumps(state)))
        self.db.commit()
        self.publish(files, lag, round((time.monotonic() - start) * 1000))
        return lag

    def publish(self, files, lag, duration):
        rows = self.db.execute('''SELECT e.* FROM events e WHERE kind='request' OR
             NOT EXISTS(SELECT 1 FROM events q WHERE q.sid=e.sid AND q.tid=e.tid AND q.kind='request') ORDER BY ts''')
        total = empty()
        usage_events = deque(maxlen=MAX_USAGE_EVENTS)
        days, models, sessions, turns = {}, {}, {}, {}
        last = None
        for row in rows:
            add(total, row)
            usage_events.append({'at': row['ts'], 'session': row['sid'], 'turn': row['tid'],
                'model': row['model'], 'tier': row['tier'], 'effort': row['effort'], 'role': row['role'],
                **empty()})
            add(usage_events[-1], row)
            last = row['ts']
            day = dt.datetime.fromtimestamp(row['ts'], self.zone).date().isoformat()
            d = days.setdefault(day, {'date': day, **empty(), 'models': {}})
            add(d, row)
            add(d['models'].setdefault(row['model'], {'model': row['model'], **empty()}), row)
            add(models.setdefault(row['model'], {'model': row['model'], **empty()}), row)
            s = sessions.setdefault(row['sid'], {'id': row['sid'], 'firstAt': row['ts'], 'lastAt': row['ts'], 'role': row['role'], **empty()})
            s['lastAt'] = row['ts']
            add(s, row)
            t = turns.setdefault(row['tid'], {'id': row['tid'], 'session': row['sid'], 'at': row['ts'],
                    'model': row['model'], 'tier': row['tier'], 'effort': row['effort'],
                    'role': row['role'], 'toolCalls': 0, 'durationSeconds': 0, **empty()})
            if t['model'] != row['model']:
                t['model'] = 'mixed'
            add(t, row)
        for tid, turn in turns.items():
            meta = self.db.execute('SELECT started,ended FROM turns WHERE id=?', (tid,)).fetchone()
            if meta:
                turn['at'] = meta['started']
                turn['durationSeconds'] = max(0, round(meta['ended'] - meta['started'], 1))
            turn['toolCalls'] = self.db.execute('SELECT count(*) FROM tools WHERE tid=?', (tid,)).fetchone()[0]
        for day in days.values():
            day['models'] = list(day['models'].values())
        states = [json.loads(r[0]) for r in self.db.execute('SELECT state FROM files')]
        snapshot = {'version': 1, 'generatedAt': time.time(), 'timezone': str(self.zone),
          'totals': total, 'daily': list(days.values())[-365:], 'models': list(models.values()),
          'sessions': sorted(sessions.values(), key=lambda s: s['lastAt'], reverse=True)[:2000],
          'turns': sorted(turns.values(), key=lambda t: t['at'], reverse=True)[:2500],
          'usageEvents': list(usage_events),
          'coverage': {'sourceFiles': files, 'lagBytes': lag, 'lastEventAt': last,
             'eventDetailsVersion': 1, 'eventLimit': MAX_USAGE_EVENTS,
             'omittedEvents': max(0, total['requests'] - len(usage_events)),
             'eventsFrom': usage_events[0]['at'] if usage_events else 0,
             'scanMs': duration, 'allSessions': len(sessions), 'allTurns': len(turns),
             'omittedTurns': max(0, len(turns) - 2500), 'daysLimit': 365,
             'malformedLines': sum(s['invalid'] for s in states),
             'oversizedLines': sum(s['oversized'] for s in states),
             'counterResets': sum(s['resets'] for s in states)},
          'pricing': self.rates}
        snapshot['coverage']['unsupportedFiles'] = self.unsupported_files
        temporary = self.output.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
        with os.fdopen(fd, 'w') as out:
            json.dump(snapshot, out, separators=(',', ':'), allow_nan=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, self.output)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', action='append', required=True)
    p.add_argument('--state', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--pricing', required=True)
    p.add_argument('--timezone', default='Asia/Kolkata')
    p.add_argument('--once', action='store_true')
    args = p.parse_args()
    os.umask(0o027)
    collector = Collector(args.source, args.state, args.output, args.pricing, args.timezone)
    while True:
        lag = collector.scan()
        if args.once:
            break
        time.sleep(2 if lag else 15)


if __name__ == '__main__':
    main()
