"""OFFLINE reaches the services that act on it.

The server reads OFFLINE (1 or true) to skip the hosted services it would
otherwise call (see server/src/utils/offline.ts). Compose forwards it by name,
empty by default, so an unset flag changes nothing.
"""

from tests.test_compose_math_env import _environment, requires_checkout


@requires_checkout
def test_server_forwards_offline_empty_by_default():
    assert _environment("docker-compose.yml", "server")["OFFLINE"] == ""


@requires_checkout
def test_server_forwards_offline_when_set():
    assert _environment("docker-compose.yml", "server", {"OFFLINE": "1"})["OFFLINE"] == "1"
