"""Shared helpers for Python tests that need the local PostgreSQL database."""

import os
import subprocess
import unittest

CONTAINER = "supabase_db_examerframe"
PIPE = "npipe:////./pipe/docker_engine"
SOCKET = "unix:///var/run/docker.sock"


class LocalDatabase:
    """Run short SQL statements in the local database with the service role."""

    def __init__(self, wsl_distro=None, platform=os.name, environ=None):
        self.wsl_distro = wsl_distro
        self.platform = platform
        self.environ = dict(os.environ if environ is None else environ)

    def command(self):
        if self.wsl_distro:
            docker = ["wsl.exe", "--distribution", self.wsl_distro, "--exec", "docker"]
            host = SOCKET
        else:
            docker = ["docker"]
            host = PIPE if self.platform in ("nt", "win32") else SOCKET
        # Disabling the Docker context keeps requests on that exact local endpoint.
        self.environ.pop("DOCKER_CONTEXT", None)
        return [
            *docker, "--host", host, "exec", "-i", CONTAINER,
            "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
        ]

    def run(self, sql, role="service_role", timeout=60):
        statement = f"begin;\nselect set_config('role', '{role}', true);\n{sql}\nrollback;\n"
        result = subprocess.run(
            self.command(),
            input=statement.encode("utf-8"),
            capture_output=True,
            timeout=timeout,
            env=self.environ,
        )
        return result

    def rows(self, sql):
        result = self.run(sql)
        if result.returncode != 0:
            raise AssertionError(
                f"Local SQL failed in {CONTAINER}: {result.stderr.decode('utf-8', 'replace')}"
            )
        return [line.split("|") for line in result.stdout.decode("utf-8").splitlines() if line]


def _probe():
    distro = os.environ.get("EXAMERFRAME_TEST_WSL_DISTRO") or None
    try:
        result = LocalDatabase(distro).run("select 1")
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


LOCAL_DATABASE_AVAILABLE = _probe()
LOCAL_DATABASE_SKIP_REASON = (
    "The local Supabase database container is not reachable; "
    "start it with the documented Supabase CLI commands."
)


def require_local_database(test):
    """Skip a database test when the local container is not reachable."""
    return unittest.skipUnless(LOCAL_DATABASE_AVAILABLE, LOCAL_DATABASE_SKIP_REASON)(test)


def quote(value):
    """Quote a trusted test value as a PostgreSQL literal."""
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"
