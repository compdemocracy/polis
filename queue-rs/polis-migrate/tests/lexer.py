#!/usr/bin/env python3
"""PostgreSQL lexical parity and atomicity, on generated isolated databases only.

Use the same owned Compose project/ports as prove.py. ORIGINAL_RUNNER optionally
proves the previous parser's behavior. No application or vote rows are used.
"""
import os
from pathlib import Path
import tempfile
import unittest

import prove


class LexerProof(unittest.TestCase):
    def run_source(self, name, source, ok, original=False, nonstandard=False):
        db = 'lexer_' + name
        prove.sql('postgres', f'CREATE DATABASE {db}')
        if nonstandard:
            prove.sql('postgres', f"ALTER DATABASE {db} SET standard_conforming_strings=off")
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'held.txt').write_text('')
            if isinstance(source, str):
                source = [source]
            for number, text in enumerate(source):
                name = '000000_initial.sql' if number == 0 else f'{number:06d}_generated.sql'
                (directory / name).write_text(text)
            (directory / 'release.txt').write_text(''.join(p.name+'\n' for p in sorted(directory.glob('*.sql'))))
            saved = prove.BIN
            try:
                if original:
                    prove.BIN = Path(os.environ['ORIGINAL_RUNNER'])
                result = prove.runner(db, 'apply', dir=directory, ok=ok)
            finally:
                prove.BIN = saved
        return db, result

    def test_01_identifier_transaction_refused_before_ddl(self):
        for prefix in ['a', 'é']:
            with self.subTest(prefix=prefix):
                db, result = self.run_source(
                    'boundary_' + ('ascii' if prefix == 'a' else 'unicode'),
                    f'CREATE TABLE {prefix}$tag$ (x int); COMMIT; '
                    'CREATE TABLE b$tag$ (y int); SELECT 1/0;', False)
                self.assertIn('transaction control', result.stderr)
                self.assertEqual(prove.sql(db,
                    "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace"), '0')

    @unittest.skipUnless(os.environ.get('ORIGINAL_RUNNER'), 'set ORIGINAL_RUNNER for before control')
    def test_02_original_leaves_committed_ddl_without_receipt(self):
        db, _ = self.run_source('original_boundary',
            'CREATE TABLE a$tag$ (x int); COMMIT; CREATE TABLE b$tag$ (y int); SELECT 1/0;',
            False, original=True)
        self.assertEqual(prove.sql(db, "SELECT to_regclass('public.a$tag$') IS NOT NULL"), 't')
        self.assertEqual(prove.sql(db, 'SELECT count(*) FROM migrations'), '0')

    def test_03_valid_identifiers_preserved(self):
        db, _ = self.run_source('valid_identifier',
            'CREATE TABLE a$tag$ (x int); CREATE TABLE é$$tail (y int);', True)
        self.assertEqual(prove.sql(db, "SELECT to_regclass('public.a$tag$') IS NOT NULL "
            "AND to_regclass('public.é$$tail') IS NOT NULL"), 't')
        self.assertEqual(prove.sql(db, 'SELECT count(*) FROM migrations'), '1')

    def test_04_unicode_dollar_body_preserved(self):
        db, _ = self.run_source('unicode_body',
            'CREATE FUNCTION public.lexical_value() RETURNS text LANGUAGE sql AS '
            "$тег_1$ SELECT 'a;b'::text $тег_1$;", True)
        self.assertEqual(prove.sql(db, 'SELECT public.lexical_value()'), 'a;b')

    def test_05_comment_newline_preserves_sql_refusal(self):
        expression = "SELECT 'a' /* first\n /* nested */ last */ 'b'"
        with self.assertRaises(AssertionError):
            prove.sql('postgres', expression)
        db, _ = self.run_source('comment_newline',
            'CREATE VIEW public.lexical_value AS ' + expression + ' AS value;', False)
        self.assertEqual(prove.sql(db, "SELECT to_regclass('public.lexical_value') IS NULL"), 't')
        self.assertEqual(prove.sql(db, 'SELECT count(*) FROM migrations'), '0')

    def test_06_session_lexical_setting_is_pinned(self):
        db, _ = self.run_source('string_setting',
            "CREATE VIEW public.lexical_value AS SELECT length('a\\b') AS value;", True,
            nonstandard=True)
        self.assertEqual(prove.sql(db, 'SELECT value FROM public.lexical_value'), '3')

    def test_07_line_comment_statement_boundary_preserved(self):
        db, _ = self.run_source('line_comment',
            'CREATE TABLE public.lexical_first(x int) -- comment\n; '
            'CREATE TABLE public.lexical_second(x int);', True)
        self.assertEqual(prove.sql(db, "SELECT to_regclass('public.lexical_first') IS NOT NULL "
            "AND to_regclass('public.lexical_second') IS NOT NULL"), 't')

    def test_08_previous_file_cannot_change_next_file_lexing(self):
        db, _ = self.run_source('next_file_setting', [
            'SET standard_conforming_strings=off;',
            "CREATE VIEW public.lexical_value AS SELECT length('a\\b') AS value;"], True)
        self.assertEqual(prove.sql(db, 'SELECT value FROM public.lexical_value'), '3')
        self.assertEqual(prove.sql(db, 'SELECT count(*) FROM migrations'), '2')

    def test_09_escaped_continuation_matches_postgres(self):
        expression = "SELECT E'a' -- explanation\n'b\\'c'"
        reference = prove.sql('postgres', expression)
        self.assertEqual(reference, "ab'c")
        db, _ = self.run_source('escaped_continuation',
            'CREATE VIEW public.lexical_value AS ' + expression + ' AS value;', True)
        self.assertEqual(prove.sql(db, 'SELECT value FROM public.lexical_value'), reference)

    def test_10_typed_literals_match_postgres(self):
        for suffix, name in [('dollar', 'typed$E'), ('unicode', 'typedéE')]:
            with self.subTest(identifier=name):
                source = (f'CREATE DOMAIN {name} AS text; '
                          f"CREATE VIEW public.lexical_value AS SELECT {name}'a\\' AS value;")
                db, _ = self.run_source('typed_' + suffix, source, True)
                self.assertEqual(prove.sql(db, 'SELECT value FROM public.lexical_value'), 'a\\')
                self.assertEqual(prove.sql(db, 'SELECT count(*) FROM migrations'), '1')


if __name__ == '__main__':
    unittest.main(verbosity=2)
