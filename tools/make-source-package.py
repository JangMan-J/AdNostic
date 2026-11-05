#!/usr/bin/env python3
"""Builds dist/adnostic-source.zip: the source archive for Mozilla's add-on review (build instructions in README.md).
Contains only what is needed to rebuild the extension and nothing generated or private."""
import os, zipfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["build.mjs", "catalogue.mjs", "package.json", "LICENSE", "README.md"]
DIRS = ["src", "tools"]
out = os.path.join(root, "dist", "adnostic-source.zip")
os.makedirs(os.path.dirname(out), exist_ok=True)
paths = [f for f in FILES if os.path.exists(os.path.join(root, f))]
for d in DIRS:
    for base, dirs, files in os.walk(os.path.join(root, d)):
        dirs[:] = sorted(x for x in dirs if x not in ("__pycache__", "node_modules"))
        paths += [os.path.relpath(os.path.join(base, f), root) for f in sorted(files)]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(paths):
        zi = zipfile.ZipInfo(p, (2026, 1, 1, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED; zi.external_attr = 0o644 << 16
        z.writestr(zi, open(os.path.join(root, p), "rb").read())
print(f"{out}: {len(paths)} files")
