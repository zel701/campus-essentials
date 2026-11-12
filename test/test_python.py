import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


parser = load_module('course_parser', ROOT / 'scripts/parse_courses_to_csv.py')
with patch.dict(sys.modules, {'boto3': MagicMock()}):
    prices = load_module('price_handler', ROOT / 'scraper-lambda/lambda_function.py')


class ParserTests(unittest.TestCase):
    def test_bom_short_subject_and_semester_number(self):
        rows = parser.parse_courses('\ufeffME 1123. Mechanics.\n3 units\nTerm Typically Offered: F\nDescription.\nAERO 121. Aerospace Fundamentals.\n2 units'.splitlines())
        self.assertEqual([(r.subject, r.number) for r in rows], [('ME', '1123'), ('AERO', '121')])
        self.assertEqual(rows[0].description, 'Description.')
        self.assertEqual(rows[0].units, '3')

    def test_combined_requirement_labels(self):
        row = parser.parse_courses(['AERO 299. Thermodynamics.', 'Prerequisite: ME 212. Corequisite: AERO 300. Recommended: AERO 215.', 'Description.'])[0]
        self.assertEqual(row.prerequisite, 'ME 212.')
        self.assertEqual(row.corequisite, 'AERO 300.')
        self.assertEqual(row.recommended, 'AERO 215.')
        self.assertEqual(row.description, 'Description.')

    def test_existing_sample_keeps_first_course(self):
        rows = parser.parse_courses((ROOT / 'scripts/input.txt').read_text().splitlines())
        self.assertEqual(len(rows), 83)
        self.assertEqual((rows[0].subject, rows[0].number), ('AERO', '121'))


class PriceTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'TABLE_NAME': 'test-table', 'ADMIN_PASSWORD': 'local-test-password'})
        self.env.start()
        self.addCleanup(self.env.stop)
        prices.boto3.reset_mock()
        prices.boto3.resource.return_value.Table.return_value.put_item.side_effect = None

    def request(self, payload=None, **overrides):
        return {'httpMethod': 'POST', 'headers': {'Authorization': 'Bearer local-test-password'}, 'body': json.dumps(payload if payload is not None else {'url': 'https://example.com/book', 'price': 1.99}), **overrides}

    def test_unauthorized_request_cannot_write(self):
        self.assertEqual(prices.handler(self.request(headers={}), None)['statusCode'], 403)
        prices.boto3.resource.assert_not_called()

    def test_unconfigured_password_fails_closed(self):
        os.environ.pop('ADMIN_PASSWORD')
        self.assertEqual(prices.handler(self.request(), None)['statusCode'], 403)

    def test_post_stores_decimal_and_uses_configured_table(self):
        self.assertEqual(prices.handler(self.request(), None)['statusCode'], 200)
        prices.boto3.resource.return_value.Table.assert_called_once_with('test-table')
        saved = prices.boto3.resource.return_value.Table.return_value.put_item.call_args.kwargs['Item']
        self.assertEqual(saved['price'], Decimal('1.99'))
        self.assertEqual(saved['entity'], 'item')

    def test_zero_price_is_allowed(self):
        self.assertEqual(prices.handler(self.request({'url': 'https://example.com/free', 'price': 0}), None)['statusCode'], 200)

    def test_invalid_input(self):
        for body in ['null', '[]', '{bad', '{"url":"https://example.com","price":NaN}', '{"url":"https://example.com","price":true}', '{"url":"javascript:alert(1)","price":2}', '{"url":"https://example.com","price":-1}']:
            with self.subTest(body=body):
                self.assertEqual(prices.handler(self.request(body=body), None)['statusCode'], 400)
        prices.boto3.resource.assert_not_called()

    def test_method_and_cors(self):
        self.assertEqual(prices.handler(self.request(httpMethod='GET'), None)['statusCode'], 405)
        res = prices.handler(self.request(httpMethod='OPTIONS', headers={}), None)
        self.assertEqual(res['statusCode'], 200)
        self.assertIn('Access-Control-Allow-Origin', res['headers'])

    def test_sdk_failure_does_not_leak_details(self):
        prices.boto3.resource.return_value.Table.return_value.put_item.side_effect = RuntimeError('private-data')
        res = prices.handler(self.request(), None)
        self.assertEqual(res['statusCode'], 500)
        self.assertNotIn('private-data', res['body'])


if __name__ == '__main__':
    unittest.main()
