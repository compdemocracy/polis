#!/usr/bin/env python3
"""Compare a server image's real version handler with a polis-api image, offline.

Both images must have been built with the same identity inputs. Run again with
source-only images (no generated identity) to check the unknown-provenance path.
The server image must contain its compiled dist/src/routes/version.js. No server
source is replaced by this harness. Only the handler's Express host is supplied,
so this test needs no database, provider, migrations, or production configuration.
"""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import time
import uuid


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-image', required=True)
    parser.add_argument('--rust-image', required=True)
    parser.add_argument('--record', type=Path, help='write the exact Node GET body')
    args = parser.parse_args()
    prefix = 'polis-version-' + uuid.uuid4().hex[:12]
    containers = [prefix + '-node', prefix + '-rust']
    network = prefix + '-net'
    # Express and handleVersion come from the actual server image.
    harness = '''const express = require("/app/node_modules/express");
const {handleVersion} = require("/app/dist/src/routes/version.js");
const app = express();
app.use(express.compress());
app.get("/api/v3/version", handleVersion);
app.listen(5000, "0.0.0.0");'''
    try:
        docker('network', 'create', '--internal', network)
        docker('run', '-d', '--name', containers[0], '--network', network,
               '--entrypoint', 'node', args.node_image, '-e', harness)
        docker('run', '-d', '--name', containers[1], '--network', network,
               '-e', 'POLIS_API_VERSION_READS=1',
               '-e', 'MATH_ENV=python', '-e', 'DEV_MODE=true',
               '-e', 'POLIS_API_DB_TRANSPORT=loopback',
               '-e', 'POLIS_API_DATABASE_URL=postgresql://unused@127.0.0.1:1/unused',
               args.rust_image)
        endpoints = [('127.0.0.1', 5000), (containers[1], 5100)]

        def request(endpoint, method='GET', path='/api/v3/version', headers=None):
            # Probe from the Node container so the network can remain internal:
            # no published ports, internet access, or host networking is needed.
            probe = '''const http=require("node:http");
const r=http.request({host:process.argv[1],port:Number(process.argv[2]),
  method:process.argv[3],path:process.argv[4],headers:JSON.parse(process.argv[5])},res=>{
  const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{
    const headers={};for(let i=0;i<res.rawHeaders.length;i+=2) headers[res.rawHeaders[i]]=res.rawHeaders[i+1];
    console.log(JSON.stringify([res.statusCode,headers,Buffer.concat(chunks).toString("base64")]));
  });
});r.setTimeout(3000,()=>r.destroy(Error("timeout")));r.on("error",()=>process.exit(1));r.end();'''
            result = json.loads(docker('exec', containers[0], 'node', '-e', probe,
                                endpoint[0], str(endpoint[1]), method, path, json.dumps(headers or {})))
            return result[0], result[1], base64.b64decode(result[2])

        for port in endpoints:
            for _ in range(100):
                try:
                    request(port)
                    break
                except (OSError, subprocess.CalledProcessError):
                    time.sleep(.1)
            else:
                raise AssertionError('version listener did not start')
        results = [request(port) for port in endpoints]
        node_body = results[0][2]
        for status, headers, body in results:
            assert status == 200, status
            assert body == node_body, (node_body, body)
            assert headers['Cache-Control'] == 'no-store', headers
            assert headers['Content-Type'] == 'application/json; charset=utf-8', headers
            assert int(headers['Content-Length']) == len(body)
        assert list(json.loads(node_body)) == [
            'version_base', 'version_display', 'commit', 'distance', 'channel', 'source']
        for method, path, headers, status in [
            ('HEAD', '/api/v3/version', {}, 200),
            ('GET', '/api/v3/version?ignored=1', {'Cookie': 'unused=1', 'Authorization': 'Bearer ignored'}, 200),
            ('GET', '/api/v3/version', {'If-None-Match': results[0][1]['ETag']}, 304),
            ('GET', '/api/v3/version', {'If-None-Match': results[0][1]['ETag'], 'Cache-Control': 'no-cache'}, 200),
        ]:
            pair = [request(port, method, path, headers) for port in endpoints]
            assert [r[0] for r in pair] == [status, status], pair
            assert pair[0][2] == pair[1][2], pair
            assert all(r[1]['Cache-Control'] == 'no-store' for r in pair), pair
            if method == 'HEAD':
                assert pair[0][2] == b''
                assert all(int(r[1]['Content-Length']) == len(node_body) for r in pair)
        if args.record:
            args.record.parent.mkdir(parents=True, exist_ok=True)
            args.record.write_bytes(node_body)
        print('PASS: Node and Rust images: identical version bytes; GET/query/HEAD/304/no-cache; no-store')
        print(node_body.decode())
    except Exception:
        for name in containers:
            subprocess.run(['docker', 'logs', name], check=False)
        raise
    finally:
        subprocess.run(['docker', 'rm', '-f', *containers], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
