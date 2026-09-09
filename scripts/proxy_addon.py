"""
Mitmproxy addon: enforces the allowlist defined in allowlist.yaml.

Each request is checked against (host, method) rules.
Wildcard hosts like *.github.com are supported.
Requests that don't match any rule receive a 403 response.
"""
import os
import yaml
from mitmproxy import http, ctx


class HarnessProxy:
    def __init__(self):
        self.rules: list[dict] = []
        self.default_methods: list[str] = ["GET"]
        self.allowlist_path: str = ""
        self._mtime: float = 0

    def load(self, _loader):
        self.allowlist_path = os.environ.get("HARNESS_ALLOWLIST", "/opt/harness/config/allowlist.yaml")
        self._load_rules(self.allowlist_path)

    def _maybe_reload(self):
        """Reload the allowlist if the file has changed on disk."""
        try:
            mtime = os.path.getmtime(self.allowlist_path)
            if mtime != self._mtime:
                self._load_rules(self.allowlist_path)
        except OSError:
            pass

    def _load_rules(self, path: str):
        with open(path) as f:
            config = yaml.safe_load(f) or {}

        self.default_methods = [m.upper() for m in config.get("default_methods", ["GET"])]
        self.rules = [
            {
                "host": entry["host"],
                "methods": [m.upper() for m in entry.get("methods", self.default_methods)],
                "comment": entry.get("comment", ""),
            }
            for entry in config.get("allowlist", [])
        ]
        self._mtime = os.path.getmtime(path)
        ctx.log.warn(f"[harness] Loaded {len(self.rules)} allowlist rules from {path}")

    def _is_allowed(self, host: str, method: str) -> bool:
        method = method.upper()
        for rule in self.rules:
            if self._host_matches(host, rule["host"]):
                return method in rule["methods"]
        return False

    def _host_matches(self, host: str, pattern: str) -> bool:
        if pattern.startswith("*."):
            domain = pattern[2:]
            return host == domain or host.endswith("." + domain)
        return host == pattern

    def request(self, flow: http.HTTPFlow):
        self._maybe_reload()
        host = flow.request.pretty_host
        method = flow.request.method

        if self._is_allowed(host, method):
            ctx.log.warn(f"[harness] ALLOW  {method:7s} {host}")
        else:
            ctx.log.warn(f"[harness] BLOCK  {method:7s} {host}")
            flow.response = http.Response.make(
                403,
                f"Claude Harness: {method} {host} is not in the allowlist\n",
                {"Content-Type": "text/plain"},
            )


addons = [HarnessProxy()]
