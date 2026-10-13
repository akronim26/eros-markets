#!/usr/bin/env python3
"""Independent raw-page/candidate review; no bot imports, network or wallet access."""
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PACKAGE = Path(__file__).resolve().parents[1]


def outcomes(raw):
    labels, tokens = raw.get('outcomes'), raw.get('clobTokenIds')
    labels = json.loads(labels) if isinstance(labels, str) else labels
    tokens = json.loads(tokens) if isinstance(tokens, str) else tokens
    assert isinstance(labels, list) and isinstance(tokens, list) and len(labels) == len(tokens) == 2
    assert all(isinstance(x, str) and x for x in labels) and len(set(labels)) == 2
    assert all(isinstance(x, str) and re.fullmatch(r'0|[1-9][0-9]*', x) and int(x) < 2**256 for x in tokens)
    assert len(set(tokens)) == 2
    return [{'label': label, 'tokenId': token} for label, token in zip(labels, tokens, strict=True)]


def reasons(event, market, tag_id):
    result = []
    for raw, field, expected, code in [
        (event, 'active', True, 'EVENT_INACTIVE'), (event, 'closed', False, 'EVENT_CLOSED'),
        (market, 'active', True, 'MARKET_INACTIVE'), (market, 'closed', False, 'MARKET_CLOSED'),
        (market, 'enableOrderBook', True, 'ORDER_BOOK_DISABLED'), (market, 'acceptingOrders', True, 'ORDERS_DISABLED'),
        (event, 'negRisk', False, 'EVENT_NEGATIVE_RISK_REQUIRES_REVIEW'),
        (market, 'negRisk', False, 'NEGATIVE_RISK_REQUIRES_REVIEW'),
        (event, 'negRiskAugmented', False, 'AUGMENTED_NEGATIVE_RISK_REQUIRES_REVIEW'),
        (event, 'enableNegRisk', False, 'NEGATIVE_RISK_EVENT_ENABLED'),
        (market, 'negRiskOther', False, 'NEGATIVE_RISK_OTHER_REQUIRES_REVIEW')]:
        value = raw.get(field)
        if type(value) is not bool:
            result.append(code + '_UNKNOWN')
        elif value is not expected:
            result.append(code)
    if not isinstance(event.get('tags'), list) or not any(isinstance(t, dict) and t.get('id') == tag_id for t in event['tags']):
        result.append('TAG_MEMBERSHIP_UNVERIFIED')
    if not isinstance(market.get('conditionId'), str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', market['conditionId']):
        result.append('CONDITION_ID_MISSING_OR_INVALID')
    try:
        outcomes(market)
    except (AssertionError, ValueError, TypeError):
        result.append('OUTCOME_MAPPING_MISSING_OR_INVALID')
    if not all(isinstance(market.get(k), str) and market[k] for k in ['question', 'description', 'resolutionSource']):
        result.append('SOURCE_RULES_INCOMPLETE')
    try:
        value = market['endDate']
        assert isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z', value)
        datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (KeyError, AssertionError, ValueError, TypeError):
        result.append('SOURCE_END_DATE_UNVERIFIED')
    return result


def review(path):
    report = json.loads(path.read_bytes())
    assert report['mode'] == 'READ_ONLY_MARKET_DISCOVERY'
    assert report['signaturesProduced'] == report['transactionsSent'] == report['configurationsActivated'] == 0
    assert report['productionApproved'] is False
    tag_capture = report['tag']['capture']
    tag = json.loads(tag_capture['body'])
    assert tag == tag_capture['data']
    assert hashlib.sha256(tag_capture['body'].encode()).hexdigest() == report['tag']['sha256']
    assert tag['id'] == report['tag']['id'] and tag['slug'] == report['options']['tagSlug']
    found, cursor, seen_events, seen_markets = [], None, set(), set()
    for page in report['pages']:
        assert page['requestedCursor'] == cursor
        capture = page['capture']
        url = urlparse(capture['url'])
        query = parse_qs(url.query)
        assert url.scheme == 'https' and url.netloc == 'gamma-api.polymarket.com' and url.path == '/events/keyset'
        assert query['closed'] == ['false'] and query['tag_id'] == [tag['id']]
        assert query['limit'] == [str(report['options']['pageSize'])]
        assert query.get('after_cursor') == ([cursor] if cursor is not None else None)
        body = json.loads(capture['body'])
        assert body == capture['data']
        assert hashlib.sha256(capture['body'].encode()).hexdigest() == page['sha256']
        assert len(body['events']) <= report['options']['pageSize']
        for event in body['events']:
            assert event['id'] not in seen_events
            seen_events.add(event['id'])
            for market in event['markets']:
                assert market['id'] not in seen_markets
                seen_markets.add(market['id'])
                candidate = report['candidates'][len(found)]
                assert candidate['eventId'] == event['id'] and candidate['externalMarketId'] == market['id']
                condition = market.get('conditionId')
                assert candidate['conditionId'] == (condition if isinstance(condition, str) and re.fullmatch(r'0x[0-9a-fA-F]{64}', condition) else None)
                assert candidate['sourcePageSha256'] == page['sha256']
                assert candidate['category'] == report['options']['category']
                assert candidate['enabled'] is False and candidate['mappingApproved'] is False and candidate['selectedOutcome'] is None
                assert 'scheduledT' not in candidate
                expected = reasons(event, market, tag['id'])
                assert expected == candidate['reasons'], (market['id'], expected, candidate['reasons'])
                assert candidate['status'] == ('BLOCKED' if expected else 'REVIEW_REQUIRED')
                if 'OUTCOME_MAPPING_MISSING_OR_INVALID' not in expected:
                    assert candidate['outcomes'] == outcomes(market)
                else:
                    assert candidate['outcomes'] == []
                for output, field in [('question', 'question'), ('description', 'description'), ('resolutionSource', 'resolutionSource'), ('sourceEndDate', 'endDate')]:
                    value = market.get(field)
                    assert candidate[output] == (value if isinstance(value, str) and value else None)
                found.append(candidate)
        cursor = body.get('next_cursor') or None
    assert len(found) == len(report['candidates'])
    assert report['scanComplete'] is (cursor is None) and report['nextCursor'] == cursor
    assert report['stopReason'] == ('END_OF_SCAN' if cursor is None else 'MAX_PAGES')
    if cursor is not None:
        assert len(report['pages']) == report['options']['maxPages']
    return {'category': report['options']['category'], 'tagId': tag['id'], 'pages': len(report['pages']),
            'candidates': len(found), 'blocked': sum(c['status'] == 'BLOCKED' for c in found),
            'scanComplete': report['scanComplete'], 'reportSha256': hashlib.sha256(path.read_bytes()).hexdigest()}


if __name__ == '__main__':
    result = {'verified': True, 'source': 'actual read-only Gamma responses',
              'cases': [review(PACKAGE / f'artifacts/discovery/{c}-live.json') for c in ['sports', 'politics', 'crypto']],
              'signaturesProduced': 0, 'transactionsSent': 0, 'configurationsActivated': 0, 'productionApproved': False}
    (PACKAGE / 'artifacts/discovery/live-review.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
