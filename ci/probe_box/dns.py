#!/usr/bin/env python3
"""Exact-name DNS forwarder for the baked host; run as private-dns UID.

The worker SG does not filter Amazon DNS. nftables allows only this UID to
reach the resolver; candidates have their own disconnected network namespace.
"""
import json
import socket
from pathlib import Path


def question(packet: bytes) -> str:
    if len(packet) < 17 or packet[4:6] != b'\x00\x01' or packet[6:12] != b'\x00' * 6:
        raise ValueError('DNS_SHAPE')
    at, labels = 12, []
    while packet[at]:
        n = packet[at]
        if n > 63 or at + n + 1 >= len(packet):
            raise ValueError('DNS_NAME')
        labels.append(packet[at + 1:at + n + 1].decode('ascii').lower())
        at += n + 1
    if len(packet) != at + 5 or packet[-2:] != b'\x00\x01' or packet[-4:-2] not in (b'\x00\x01', b'\x00\x1c'):
        raise ValueError('DNS_TYPE')
    return '.'.join(labels)


def run() -> None:
    b = json.loads(Path('/opt/polis-probe/bootstrap.json').read_bytes())
    allowed = set(b['dnsNames'])
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('127.0.0.1', 53))
    while True:
        packet, sender = sock.recvfrom(4096)
        try:
            if question(packet) not in allowed:
                raise ValueError('DNS_DENIED')
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as upstream:
                upstream.settimeout(3)
                upstream.connect((b['resolver'], 53))
                upstream.send(packet)
                response = upstream.recv(65535)
                if response[:2] != packet[:2]:
                    raise ValueError('DNS_ID')
            sock.sendto(response, sender)
        except Exception:
            # REFUSED, never include payload in a log.
            if len(packet) >= 12:
                sock.sendto(packet[:2] + b'\x81\x85' + packet[4:6] + b'\x00' * 6 + packet[12:], sender)


if __name__ == '__main__':
    run()
