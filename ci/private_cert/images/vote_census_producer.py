"""Package the sealed aggregate projection; no database access."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from vote_census import evidence,encoded,fail
from receipt import decode_json

def main():
 if sys.argv[1:]!=['produce']: fail()
 p=decode_json(Path('/input/projection.json').read_bytes())
 Path('/output/evidence.json').write_bytes(encoded(evidence(p)))

if __name__=='__main__':
 try: main()
 except Exception: raise SystemExit('VOTE_CENSUS_PRODUCER_FAILED') from None
