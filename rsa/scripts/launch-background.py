#!/usr/bin/env python3
"""Start a workspace command as a temporary macOS launchd job (no auto-restart)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--label", help="Explicit launchd label for a shared application")
parser.add_argument("--log-dir", type=Path, help="Explicit log and plist directory for a shared application")
parser.add_argument("name", help="Job name, e.g. host or emulator")
parser.add_argument("command", nargs=argparse.REMAINDER, help="Command and arguments to run in the current workspace")
args = parser.parse_args()
if not args.command:
    parser.error("a command is required")
workspace = Path.cwd().resolve()
identity = hashlib.sha256(str(workspace).encode()).hexdigest()[:16]
label = args.label or f"dev.ludens.rsa.{identity}.{args.name}"
domain = f"gui/{os.getuid()}"
target = f"{domain}/{label}"
if subprocess.run(["launchctl", "print", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
    parser.error(f"job already registered: {target}; use launchctl bootout {target} before replacing it")
executable = shutil.which(args.command[0])
if not executable:
    parser.error(f"command not found: {args.command[0]}")
logs = args.log_dir.resolve() if args.log_dir else workspace / "logs" / "background"
logs.mkdir(parents=True, exist_ok=True)
config = logs / f"{args.name}.plist"
output = logs / f"{args.name}.log"
job = {
    "Label": label,
    "ProgramArguments": [str(Path(executable).resolve()), *args.command[1:]],
    "WorkingDirectory": str(workspace),
    "EnvironmentVariables": {"PATH": os.environ.get("PATH", os.defpath), **{
        key: os.environ[key] for key in (
            "XDG_STATE_HOME", "RSA_PYTHON", "LUDENS_HOME", "SSH_AUTH_SOCK",
            "RSA_PERCEPTION_HOT_SECONDS", "RSA_PERCEPTION_PERSIST", "RSA_PERCEPTION_SEGMENT_SECONDS",
            "RSA_PERCEPTION_HOT_BYTES", "RSA_PERCEPTION_SEGMENT_BYTES",
        ) if key in os.environ
    }},
    "StandardOutPath": str(output),
    "StandardErrorPath": str(output),
    "RunAtLoad": True,
    "KeepAlive": False,
    "ProcessType": "Interactive",
}
with config.open("wb") as file:
    plistlib.dump(job, file)
subprocess.run(["launchctl", "bootstrap", domain, str(config)], check=True)
print(json.dumps({"target": target, "workspace": str(workspace), "log": str(output), "plist": str(config)}))
