#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
packager="${repo_root}/.terraform/modules/heroku_logs_lambda/package.py"
package_spec="${repo_root}/support/lambda_heroku/package_sources.json"

if [[ ! -f "${packager}" ]]; then
  echo "Missing ${packager}. Run 'terraform init -backend=false' first." >&2
  exit 1
fi

python3 - "${repo_root}" "${packager}" "${package_spec}" <<'PY'
import json
import hashlib
import os
import subprocess
import sys
import tempfile
import zipfile

repo_root, packager, package_spec = sys.argv[1:]
lambda_root = os.path.join(repo_root, "support", "lambda_heroku")

with open(package_spec, encoding="utf-8") as fh:
    claims = json.load(fh)

expanded_claims = []
for claim in claims:
    expanded_claims.append({key: os.path.join(lambda_root, value) for key, value in claim.items()})

with open(packager, "rb") as fh:
    packager_hash = hashlib.sha256(fh.read()).hexdigest()

query = {
    "paths": json.dumps({
        "module": repo_root,
        "root": repo_root,
        "cwd": repo_root,
    }),
    "docker": None,
    "artifacts_dir": "builds",
    "runtime": "nodejs22.x",
    "source_path": json.dumps(expanded_claims),
    "hash_extra": "",
    "hash_internal": json.dumps([packager_hash]),
    "recreate_missing_package": True,
    "quiet": "true",
    "function_name": "heroku-logs-lambda",
}

try:
    prepare = subprocess.run(
        ["python3", packager, "prepare"],
        input=json.dumps(query).encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=repo_root,
        check=True,
    )
except subprocess.CalledProcessError as error:
    sys.stderr.write(error.stdout.decode())
    sys.stderr.write(error.stderr.decode())
    raise SystemExit(error.returncode) from error

sys.stderr.write(prepare.stderr.decode())
build_info = json.loads(prepare.stdout)

subprocess.run(
    [
        "python3",
        packager,
        "build",
        "--timestamp",
        build_info["timestamp"],
        build_info["build_plan_filename"],
    ],
    cwd=repo_root,
    check=True,
)

zip_path = os.path.join(repo_root, build_info["filename"])
with zipfile.ZipFile(zip_path) as archive:
    names = set(archive.namelist())
    required_files = {"package.json", "lambda_heroku_logs_index.js"}
    missing = sorted(required_files - names)
    if missing:
        raise SystemExit(f"Lambda package is missing required runtime files: {', '.join(missing)}")

    with tempfile.TemporaryDirectory(prefix="heroku-logs-lambda-") as temp_dir:
        archive.extractall(temp_dir)

        with open(os.path.join(temp_dir, "package.json"), encoding="utf-8") as fh:
            package_json = json.load(fh)

        if package_json.get("type") != "module":
            raise SystemExit("Lambda package.json must set type=module")

        node_check = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                (
                    "import { pathToFileURL } from 'node:url';"
                    "const mod = await import(pathToFileURL(process.cwd() + '/lambda_heroku_logs_index.js'));"
                    "if (typeof mod.handler !== 'function') {"
                    "  throw new Error('lambda_heroku_logs_index.js does not export handler');"
                    "}"
                ),
            ],
            cwd=temp_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        if node_check.returncode != 0:
            sys.stderr.write(node_check.stdout)
            sys.stderr.write(node_check.stderr)
            raise SystemExit("Unable to import the packaged Heroku logs Lambda handler")

print(f"Validated packaged Heroku logs Lambda at {zip_path}")
PY
