"""Numerical runtime provenance. Configure before importing numpy/scipy."""
import os
import platform


def environment(environ, system, machine):
    result = dict(environ)
    result.pop('OPENBLAS_CORETYPE', None)
    if (system, machine) == ('Linux', 'x86_64'):
        result['OPENBLAS_CORETYPE'] = 'Haswell'
    return result


def configure():
    selected = environment(os.environ, platform.system(), platform.machine())
    os.environ.pop('OPENBLAS_CORETYPE', None)
    if 'OPENBLAS_CORETYPE' in selected:
        os.environ['OPENBLAS_CORETYPE'] = selected['OPENBLAS_CORETYPE']


def observe():
    import numpy as np
    import scipy.linalg
    from threadpoolctl import threadpool_info
    np.dot(np.ones((2, 2)), np.ones((2, 2)))
    scipy.linalg.blas.dgemm(1, np.eye(2), np.eye(2))
    rows = [{k: row[k] for k in ('prefix', 'internal_api', 'architecture', 'version', 'num_threads')}
            for row in threadpool_info() if row['user_api'] == 'blas']
    requested = os.environ.get('OPENBLAS_CORETYPE') or 'not-forced'
    if (platform.system(), platform.machine()) not in {('Linux','x86_64'),('Linux','aarch64'),('Darwin','arm64')}:
        raise RuntimeError('REPLAY_KERNEL_PLATFORM_UNADMITTED')
    expected = environment({}, platform.system(), platform.machine()).get('OPENBLAS_CORETYPE', 'not-forced')
    prefixes = {r['prefix'] for r in rows}
    if (requested != expected or not 1 <= len(rows) <= 2 or len(prefixes) != len(rows)
        or 'libopenblas' not in prefixes or not prefixes <= {'libopenblas', 'libscipy_openblas'}
        or (requested != 'not-forced' and len(rows) != 2)
        or any(r['internal_api'] != 'openblas' or r['num_threads'] != 1 for r in rows)
        or (requested != 'not-forced' and any(r['architecture'].lower() != requested.lower() for r in rows))):
        raise RuntimeError('REPLAY_KERNEL_NOT_HONOURED')
    return {'schema': 'polis-math-kernel/1', 'system': platform.system(), 'machine': platform.machine(),
            'requested': requested, 'observed': sorted(rows, key=lambda r: r['prefix'])}
