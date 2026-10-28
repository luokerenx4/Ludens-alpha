#!/bin/sh
set -eu
exec bun "$RSA_BENCH_TASK_DIR/tests/verify.ts"
