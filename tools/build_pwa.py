"""Generate the service worker's immutable release inventory after changing web assets."""
import hashlib
import json
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]


def build():
    paths = [
        SITE / name for name in
        ("index.html", "app.js", "charts.js", "style.css", "manifest.webmanifest", "data/manifest.json", "basis.html", "basis.pdf", "basis6.html", "basis6.pdf", "returns7.html", "returns7.pdf", "opportunities8.html", "opportunities8.pdf", "robustness9.html", "robustness9.pdf")
    ]
    paths.extend(path for path in (SITE / "online").glob("*.js") if path.name != "release.js")
    paths.extend((SITE / "icons").glob("*"))
    paths.extend((SITE / "reference").glob("*.json"))
    files = {path.relative_to(SITE).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(paths) if path.is_file()}
    worker = (SITE / "sw.js").read_bytes()
    version = hashlib.sha256(worker + json.dumps(files, sort_keys=True).encode()).hexdigest()
    output = json.dumps({"version": version, "files": files}, indent=2)
    (SITE / "online/release.js").write_bytes(("self.RESEARCH_RELEASE = " + output + ";\n").encode())
    return version


if __name__ == "__main__":
    print(build())
