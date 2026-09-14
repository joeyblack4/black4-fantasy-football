import unittest
from token_economics import calculate


class ReferenceCostTests(unittest.TestCase):
    def row(self, **changes):
        return {'granularity': 'call', 'tokens': {'uncachedInput': 100, 'cacheRead': 80, 'cacheWrite': 0, 'output': 10}, 'rawUsage': {}, **changes}

    def test_cached_input_is_disjoint(self):
        r = calculate(self.row(), {'prompt': '0.01', 'input_cache_read': '0.001', 'completion': '0.02'})
        self.assertEqual(r['lowUsd'], '1.280')

    def test_one_hour_cache_creation_uses_its_rate(self):
        row = self.row(tokens={'uncachedInput': 0, 'cacheRead': 0, 'cacheWrite': 100, 'output': 0}, rawUsage={'cache_creation': {'ephemeral_1h_input_tokens': 75, 'ephemeral_5m_input_tokens': 25}})
        r = calculate(row, {'prompt': '1', 'completion': '1', 'input_cache_write': '2', 'input_cache_write_1h': '3'})
        self.assertEqual(r['lowUsd'], '275')

    def test_missing_cache_counts_are_not_free(self):
        row = self.row(tokens={'uncachedInput': 100, 'cacheRead': None, 'cacheWrite': None, 'output': 10})
        self.assertEqual(calculate(row, {'prompt': '1', 'completion': '1'})['status'], 'unknown')

    def test_missing_advertised_discount_is_explicit(self):
        result = calculate(self.row(), {'prompt': '1', 'completion': '1'})
        self.assertEqual(result['lowUsd'], '190')
        self.assertIn('no_advertised_cache_discount_standard_input_rate_used', result['flags'])

    def test_aggregate_tier_is_range_not_one_large_request(self):
        pricing = {'prompt': '1', 'completion': '1', 'overrides': [{'min_prompt_tokens': 100, 'prompt': '2', 'completion': '2'}]}
        r = calculate(self.row(granularity='turn-aggregate'), pricing)
        self.assertEqual((r['lowUsd'], r['highUsd']), ('190', '380'))

    def test_cache_ttl_mismatch_fails_closed(self):
        row = self.row(tokens={'uncachedInput': 0, 'cacheRead': 0, 'cacheWrite': 100, 'output': 0}, rawUsage={'cache_creation': {'ephemeral_1h_input_tokens': 60, 'ephemeral_5m_input_tokens': 25}})
        r = calculate(row, {'prompt': '1', 'completion': '1', 'input_cache_write': '2', 'input_cache_write_1h': '3'})
        self.assertEqual(r['status'], 'unknown')

    def test_request_tier_uses_observed_request_size(self):
        pricing = {'prompt': '1', 'completion': '1', 'overrides': [{'min_prompt_tokens': 100, 'prompt': '2', 'completion': '2'}]}
        r = calculate(self.row(), pricing)
        self.assertEqual((r['lowUsd'], r['highUsd']), ('380', '380'))


if __name__ == '__main__':
    unittest.main()
