#!/usr/bin/env bash
# Validates the Heroku logs Lambda package without Terraform: builds the same zip as
# the archive_file data source (the files listed in package_sources.json), checks that
# the handler only imports Node.js built-ins, the runtime-provided AWS SDK and packaged
# files, and imports the packaged handler.
#
# Usage: check-heroku-logs-lambda-package.sh [lambda-source-dir]
# The AWS SDK development dependencies must be installed (npm ci) in the source dir.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lambda_root="$(cd "${1:-${script_dir}/../support/lambda_heroku}" && pwd)"

python3 - "${lambda_root}" <<'PY'
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile

lambda_root = sys.argv[1]
required_files = {"package.json", "lambda_heroku_logs_index.js", "lambda_heroku_logs_helpers.js"}
import_pattern = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]""")

with open(os.path.join(lambda_root, "package_sources.json"), encoding="utf-8") as fh:
    claims = json.load(fh)

invalid_claims = [claim for claim in claims if list(claim) != ["path"]]
if invalid_claims:
    raise SystemExit(f"package_sources.json may only list files as {{\"path\": ...}}, found {invalid_claims}")

paths = sorted(claim["path"] for claim in claims)
missing = sorted(required_files - set(paths))
if missing:
    raise SystemExit(f"Lambda package is missing required runtime files: {', '.join(missing)}")

node_modules = os.path.join(lambda_root, "node_modules")
if not os.path.isdir(os.path.join(node_modules, "@aws-sdk")):
    raise SystemExit(f"Missing AWS SDK development dependencies. Run 'npm ci' in {lambda_root} first.")

with tempfile.TemporaryDirectory(prefix="heroku-logs-lambda-") as temp_dir:
    zip_path = os.path.join(temp_dir, "package.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in paths:
            archive.write(os.path.join(lambda_root, path), path)

    package_dir = os.path.join(temp_dir, "package")
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(package_dir)

    with open(os.path.join(package_dir, "package.json"), encoding="utf-8") as fh:
        if json.load(fh).get("type") != "module":
            raise SystemExit("Lambda package.json must set type=module")

    for path in paths:
        if not path.endswith(".js"):
            continue
        with open(os.path.join(package_dir, path), encoding="utf-8") as fh:
            specifiers = import_pattern.findall(fh.read())
        for specifier in specifiers:
            if specifier.startswith("node:") or specifier.startswith("@aws-sdk/"):
                continue
            if specifier.startswith("./") and os.path.normpath(os.path.join(os.path.dirname(path), specifier)) in paths:
                continue
            raise SystemExit(
                f"{path} imports '{specifier}', which is neither a Node.js built-in, the runtime-provided AWS SDK "
                "nor a packaged file"
            )

    # The Lambda runtime provides the AWS SDK; locally it resolves from the dev dependencies.
    os.symlink(node_modules, os.path.join(package_dir, "node_modules"))
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
        cwd=package_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if node_check.returncode != 0:
        sys.stderr.write(node_check.stdout)
        sys.stderr.write(node_check.stderr)
        raise SystemExit("Unable to import the packaged Heroku logs Lambda handler")

print(f"Validated Heroku logs Lambda package from {lambda_root}: {', '.join(paths)}")
PY
