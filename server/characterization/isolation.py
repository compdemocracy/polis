"""Shared host/seed isolation checks; no Docker or database side effects."""
import re

PORT_KEYS = ("POLIS_RECOVERY_PG_PORT", "P027_HTTP_PORT", "P027_CONTROL_PORT")


def isolated_environment(environ):
    env = dict(environ)
    project = env.get("COMPOSE_PROJECT_NAME", "")
    if not re.fullmatch(r"p027[a-z0-9_-]*-[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?", project):
        raise RuntimeError("set a unique COMPOSE_PROJECT_NAME=p027<task>-<random>")

    def port(key, default=None):
        value = env.get(key, default)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
            raise RuntimeError(f"{key} must be an explicit decimal port")
        return int(value)

    low = port("P027_PORT_MIN", "55930")
    high = port("P027_PORT_MAX", "55939")
    if not 55432 <= low <= high <= 65535 or high - low < 2:
        raise RuntimeError("P027_PORT_MIN/MAX must allow at least three ports in 55432..65535")
    ports = [port(key) for key in PORT_KEYS]
    if len(set(ports)) != 3 or any(p < low or p > high for p in ports):
        raise RuntimeError(f"set three distinct host ports in {low}..{high}")
    env["RECOVERY_PG_PORT"] = str(ports[0])
    return env
