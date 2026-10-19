"""Measure the schema census in coordinator-rs/src/schema/catalog.json.

Applies every numbered migration (server/postgres/migrations/0*.sql, in name
order) to an EMPTY disposable PostgreSQL 17 database, as the campaign does, and
measures public columns, indexes and constraints. Reviewed declaration pointers
already in the catalog are kept; a pointer is located only for a table or
column the catalog does not yet describe, and every located pointer is printed
for review. It also prints row! declarations for undescribed tables/columns.
Nothing is written unless --write is given.

    python3 coordinator-rs/tools/schema_census.py postgresql://postgres@127.0.0.1:PORT/census
    python3 coordinator-rs/tools/schema_census.py URL --through 000022   # must reproduce the catalog
    python3 coordinator-rs/tools/schema_census.py URL --write

The database must be empty and on 127.0.0.1; the caller owns and removes it.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

import psycopg2

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "server/postgres/migrations"
CATALOG = ROOT / "coordinator-rs/src/schema/catalog.json"
ROWS = ROOT / "coordinator-rs/src/schema/rows.rs"
RUST = {"int2": "i16", "int4": "i32", "int8": "i64", "oid": "u32", "bool": "bool",
        "text": "String", "varchar": "String", "name": "String", "uuid": "PgUuid",
        "float4": "PgFloat4", "float8": "PgFloat8", "bytea": "Vec<u8>", "json": "PgJson",
        "jsonb": "PgJson", "timestamptz": "PgTimestamp", "_text": "Vec<Option<String>>",
        "_float4": "Vec<Option<PgFloat4>>", "job_status": "JobStatus"}
KEYWORDS = {"mod", "type", "ref", "match", "move", "loop", "use", "where", "self", "static", "fn", "in"}


def migrations(through):
    files = sorted(p for p in MIGRATIONS.glob("0*.sql"))
    return [p for p in files if through is None or p.name[:6] <= through]


def measure(cur):
    cur.execute("""SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
                          c.column_default, c.ordinal_position,
                          format_type(a.atttypid, a.atttypmod)
                   FROM information_schema.columns c
                   JOIN information_schema.tables t USING (table_schema, table_name)
                   JOIN pg_attribute a ON a.attrelid = format('public.%I', c.table_name)::regclass
                                      AND a.attname = c.column_name
                   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
                   ORDER BY c.table_name, c.ordinal_position""")
    tables = {}
    for table, name, sql_type, udt, nullable, default, ordinal, definition in cur.fetchall():
        tables.setdefault(table, {"columns": [], "indexes": [], "constraints": []})["columns"].append(
            {"table": table, "name": name, "sql_type": sql_type, "udt": udt, "nullable": nullable,
             "default": default, "ordinal": ordinal, "definition_type": definition})
    cur.execute("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' "
                "ORDER BY tablename, indexname")
    for table, name, definition in cur.fetchall():
        if table in tables:
            tables[table]["indexes"].append({"table": table, "name": name, "definition": definition})
    cur.execute("""SELECT r.relname, c.conname, pg_get_constraintdef(c.oid)
                   FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = r.relnamespace
                   WHERE n.nspname = 'public' ORDER BY r.relname, c.conname""")
    for table, name, definition in cur.fetchall():
        if table in tables:
            tables[table]["constraints"].append({"table": table, "name": name, "definition": definition})
    return tables


def statements(files):
    """(file, first line, lines) of each CREATE TABLE / ALTER TABLE statement."""
    for path in files:
        lines = path.read_text().splitlines()
        rel = str(path.relative_to(ROOT))
        for i, line in enumerate(lines):
            if re.match(r"\s*(CREATE TABLE|ALTER TABLE)\b", line, re.I):
                depth, body = 0, []
                for j in range(i, len(lines)):
                    text = lines[j].split("--", 1)[0]
                    body.append((j + 1, text))
                    depth += text.count("(") - text.count(")")
                    if ";" in text and depth <= 0:
                        break
                yield rel, i + 1, body


def table_pattern(table):
    return re.compile(r'(?:TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?)(?:public\.)?"?%s"?(?:\s|\(|$)' % re.escape(table), re.I)


def locate_table(files, table):
    for rel, first, body in statements(files):
        if re.match(r"\s*CREATE TABLE", body[0][1], re.I) and table_pattern(table).search(body[0][1]):
            return f"{rel}:{first}"
    return None


def locate_column(files, table, column):
    name = re.escape(column)
    created = adds = None
    for rel, first, body in statements(files):
        if not table_pattern(table).search(body[0][1]):
            continue
        create = re.match(r"\s*CREATE TABLE", body[0][1], re.I)
        for number, text in body:
            if create and created is None and re.search(r'(?:^|[(,])\s*"?%s"?\s+[a-z]' % name, text, re.I):
                created = f"{rel}:{number}"
            if (not create and adds is None and
                    re.search(r'ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?%s"?\s' % name, text, re.I)):
                adds = f"{rel}:{number}"
    return created or adds


def reviewed_types():
    """Every existing declaration must agree with RUST, so new ones follow it."""
    pattern = re.compile(r'^\s+r?#?\w+: (.+?) => \("(\w+)", "(\w+)", (true|false), ')
    for line in ROWS.read_text().splitlines():
        match = pattern.match(line)
        if match:
            ty, _, udt, nullable = match.groups()
            expected = RUST[udt] if nullable == "false" else f"Option<{RUST[udt]}>"
            if ty != expected:
                raise SystemExit(f"rows.rs disagrees with the type map: {line.strip()}")


def declaration(table, columns, source):
    struct = "".join(part.capitalize() for part in table.split("_")) + "Row"
    out = ["row! {", f'    {struct}, "{table}", "{source}";']
    for c in columns:
        if c["udt"] not in RUST:
            raise SystemExit(f"unrepresented PostgreSQL type {c['udt']} for {table}.{c['name']}")
        nullable = c["nullable"] == "YES"
        ty = f"Option<{RUST[c['udt']]}>" if nullable else RUST[c["udt"]]
        field = f"r#{c['name']}" if c["name"] in KEYWORDS else c["name"]
        out.append(f'    {field}: {ty} => ("{c["name"]}", "{c["udt"]}", {str(nullable).lower()}, "{c["introduced"]}"),')
    return "\n".join(out + ["}"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url")
    parser.add_argument("--through", help="apply migrations up to this six-digit prefix only")
    parser.add_argument("--write", action="store_true", help="rewrite catalog.json")
    args = parser.parse_args()
    if urlparse(args.url).hostname != "127.0.0.1":
        raise SystemExit("census database must be on 127.0.0.1")
    reviewed_types()
    files = migrations(args.through)
    conn = psycopg2.connect(args.url)
    with conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE n.nspname = 'public'")
        if cur.fetchone()[0]:
            raise SystemExit("census database is not empty")
        for path in files:
            cur.execute(path.read_text())
        cur.execute("SELECT version()")
        print(cur.fetchone()[0], file=sys.stderr)
        measured = measure(cur)
        conn.rollback()
    conn.close()
    old = json.loads(CATALOG.read_text())
    old_tables = {t["table"]: t for t in old["tables"]}
    tables, located, rows = [], [], []
    for name in sorted(measured):
        entry, prior = measured[name], old_tables.get(name)
        source = prior["introduced"] if prior else locate_table(files, name)
        if not prior:
            located.append(f"table {name}: {source}")
        prior_columns = {c["name"]: c for c in prior["columns"]} if prior else {}
        new_columns = []
        for column in entry["columns"]:
            if column["name"] in prior_columns:
                column["introduced"] = prior_columns[column["name"]]["introduced"]
            else:
                column["introduced"] = locate_column(files, name, column["name"])
                located.append(f"column {name}.{column['name']}: {column['introduced']}")
                new_columns.append(column)
            if not column["introduced"]:
                raise SystemExit(f"no declaration found for {name}.{column['name']}")
        tables.append({"table": name, "introduced": source, **entry})
        if new_columns:
            rows.append(declaration(name, entry["columns"], source))
    gone = sorted(set(old_tables) - set(measured))
    catalog = {"tables": tables, "migrations": [
        {"path": str(p.relative_to(ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
    text = json.dumps(catalog, indent=2) + "\n"
    print("\n".join(located) or "no new tables or columns")
    if gone:
        print("tables no longer present: " + ", ".join(gone))
    print("\n\n".join(rows))
    same = text == CATALOG.read_text()
    print("catalog unchanged" if same else "catalog differs", file=sys.stderr)
    if args.write and not same:
        CATALOG.write_text(text)


if __name__ == "__main__":
    main()
