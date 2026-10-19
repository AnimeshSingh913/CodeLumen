#!/usr/bin/env bash
# Verifies the running API isolates submitted code. Usage: sandbox-smoke.sh <base-url>
set -euo pipefail
BASE="${1:-http://localhost:8000}"
fail() { echo "FAIL: $*" >&2; exit 1; }

run() { # $1 = language, $2 = code
  python3 -c 'import json,sys; print(json.dumps({"language": sys.argv[1], "code": sys.argv[2]}))' "$1" "$2" |
    curl -s -X POST "$BASE/run" -H 'Content-Type: application/json' --data @-
}

health=$(curl -fs "$BASE/health")
echo "$health" | grep -q '"sandbox":"hardened"' || fail "sandbox is not in hardened mode: $health"

out=$(run py 'import os; print("uid", os.getuid()); print("env", os.environ.get("GROQ_API_KEY"))')
echo "$out"
echo "$out" | grep -q 'uid 10001' || fail "program is not running as the sandbox user"
echo "$out" | grep -q 'leak-canary-value' && fail "server secret leaked through the environment"

out=$(run py 'print(open("/proc/1/environ").read())')
echo "$out" | grep -q 'leak-canary-value' && fail "server secret readable via /proc/1/environ"

out=$(run py 'import os; print(os.listdir("/app"))')
echo "$out" | grep -q 'index.js' && fail "app source is readable by submitted code"

out=$(run cpp '#include "/app/index.js"
int main(){}')
echo "$out" | grep -q 'createApp' && fail "compiler can read app source"

out=$(run py 'import os
while True: os.fork()')
echo "fork bomb result: $out"
curl -fs "$BASE/health" > /dev/null || fail "API died after fork bomb"

out=$(run java 'public class Solution { public static void main(String[] a){ System.out.println("java ok"); } }')
echo "$out" | grep -q 'java ok' || fail "java did not run: $out"

echo "Sandbox smoke test passed."
