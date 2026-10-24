#!/usr/bin/env python3
"""Verify or restore the pinned, unmodified upstream CUA contract snapshot.

Default/--check is offline. --sync needs an upstream checkout containing the
pinned commit and the matching macOS binary for its read-only docs projection.
Nothing starts an MCP server, captures the desktop, or sends input.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1] / "contracts" / "cua-driver"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Verify local bytes without network or native runtime")
    mode.add_argument("--sync", action="store_true", help="Restore pinned bytes from an upstream checkout and matching binary")
    parser.add_argument("--checkout", type=Path, help="trycua/cua Git checkout; only git show is used")
    parser.add_argument("--cua-command", default="cua-driver")
    args = parser.parse_args()
    source = json.loads((ROOT / "source.json").read_text())
    if args.sync and not args.checkout:
        parser.error("--sync requires --checkout")
    pending = []
    for entry in source["files"]:
        target = ROOT / entry["path"]
        if args.sync:
            if "upstreamPath" in entry:
                data = subprocess.check_output([
                    "git", "-C", str(args.checkout), "show",
                    f'{source["revision"]}:{entry["upstreamPath"]}',
                ])
            else:
                if sys.platform != entry["platform"]:
                    raise ValueError(f'{entry["path"]} requires {entry["platform"]}')
                data = subprocess.check_output([args.cua_command, *entry["command"][1:]])
                docs = json.loads(data)
                if docs["version"] != source["driverVersion"]:
                    raise ValueError(f'Expected Cua Driver {source["driverVersion"]}, got {docs["version"]}')
        else:
            data = target.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != entry["sha256"]:
            raise ValueError(f'{entry["path"]}: checksum mismatch; do not silently update the pinned contract')
        pending.append((target, data))
    if args.sync:
        for target, data in pending:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    print(f'{"Restored" if args.sync else "Verified"} {len(pending)} Cua Driver {source["driverVersion"]} contract files ({source["revision"]})')


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
