"""Normalize permitted metadata only; no DB driver or connection."""
import copy
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from roles_census import encoded, normalize, validate_census


def produce(value):
    rows=normalize(copy.deepcopy(value['census']))
    validate_census(rows,complete=False)
    return rows


def main():
    if sys.argv[1:]!=['produce']:raise ValueError('CENSUS_ACTION')
    value=json.loads(Path('/input/projection.json').read_bytes())
    Path('/output/census.json').write_bytes(encoded(produce(value)))


if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('CENSUS_PRODUCER_FAILED') from None
