"""Validate all intermediate objects with the image's native OpenSSL library.

Use the actual HTTPX/stdlib contexts and requests/botocore CA files. No network,
TLS EKU or wall-clock validity checks: code-signing objects are included.
"""
import ctypes as c
import ctypes.util
import re
import ssl
import sys
from pathlib import Path

import botocore.httpsession
import certifi

PEM = re.compile(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', re.S)
lib = c.CDLL(ctypes.util.find_library('crypto'))


def bind(name, result, *arguments):
    function = getattr(lib, name)
    function.restype = result
    function.argtypes = arguments
    return function


ptr = c.c_void_p
bio_new = bind('BIO_new_mem_buf', ptr, ptr, c.c_int)
bio_free = bind('BIO_free', c.c_int, ptr)
read_cert = bind('PEM_read_bio_X509', ptr, ptr, ptr, ptr, ptr)
free_cert = bind('X509_free', None, ptr)
new_store = bind('X509_STORE_new', ptr)
free_store = bind('X509_STORE_free', None, ptr)
add_cert = bind('X509_STORE_add_cert', c.c_int, ptr, ptr)
set_flags = bind('X509_STORE_set_flags', c.c_int, ptr, c.c_ulong)
new_ctx = bind('X509_STORE_CTX_new', ptr)
free_ctx = bind('X509_STORE_CTX_free', None, ptr)
init_ctx = bind('X509_STORE_CTX_init', c.c_int, ptr, ptr, ptr, ptr)
verify = bind('X509_verify_cert', c.c_int, ptr)
get_error = bind('X509_STORE_CTX_get_error', c.c_int, ptr)
version = bind('OpenSSL_version', c.c_char_p, c.c_int)
if version(0).decode() != ssl.OPENSSL_VERSION:
    raise AssertionError('Loaded libcrypto does not match Python ssl')


def parse(text):
    data = text.encode()
    bio = bio_new(data, len(data))
    if not bio:
        raise AssertionError('BIO allocation failed')
    try:
        cert = read_cert(bio, None, None, None)
        if not cert:
            raise AssertionError('certificate parse failed')
        return cert
    finally:
        bio_free(bio)


def check(roots, objects, accepted, label):
    store = new_store()
    if not store:
        raise AssertionError('store allocation failed')
    try:
        # X509_V_FLAG_NO_CHECK_TIME. No purpose set: generic PKIX validation.
        assert set_flags(store, 0x200000) == 1
        for root in set(roots):
            cert = parse(root)
            try:
                assert add_cert(store, cert) == 1
            finally:
                free_cert(cert)
        for text in objects:
            cert, ctx = parse(text), new_ctx()
            try:
                assert ctx and init_ctx(ctx, store, cert, None) == 1
                result = verify(ctx)
                error = get_error(ctx)
                if accepted:
                    assert result == 1 and error == 0, (label, result, error)
                else:
                    assert result == 0 and error in {2, 18, 19, 20, 21, 28}, (label, result, error)
            finally:
                free_ctx(ctx)
                free_cert(cert)
    finally:
        free_store(store)
    print(f'PASS Python native {label}: 16/16 ' + ('stale-store acceptances' if accepted else 'distrust refusals'))


objects = PEM.findall(Path('/audit/fixtures/affected-intermediates.pem').read_text())
assert len(objects) == 16
check(PEM.findall(Path('/audit/fixtures/affected-roots.pem').read_text()), objects, True, 'old roots')
paths = {certifi.where(), botocore.httpsession.get_cert_path(True)}
try:
    import requests.certs
except ImportError:
    if '--boto-only' not in sys.argv:
        raise
else:
    paths.add(requests.certs.where())
for path in sorted(paths):
    check(PEM.findall(Path(path).read_text()), objects, False, path)
contexts = {'stdlib': ssl.create_default_context()}
try:
    import httpx
except ImportError:
    if '--boto-only' not in sys.argv:
        raise
else:
    contexts['HTTPX'] = httpx.create_ssl_context()
for label, context in contexts.items():
    roots = [ssl.DER_cert_to_PEM_cert(cert) for cert in context.get_ca_certs(binary_form=True)]
    assert roots, f'empty {label} context'
    check(roots, objects, False, label)
