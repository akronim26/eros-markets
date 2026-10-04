#!/usr/bin/env python3
"""Validate prepared Render deployment against its retained official JSON schema.

Usage: verify-deployment.py OFFICIAL_SCHEMA_JSON
Requires PyYAML/jsonschema; makes no network requests or account mutations.
"""
import hashlib
import json
from pathlib import Path
import sys
import yaml
from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    raise SystemExit('RENDER_SCHEMA_FILE_REQUIRED')
schema_path = Path(sys.argv[1])
schema = json.loads(schema_path.read_text())
assert schema['$id'] == 'https://render.com/schema/render.yaml.json'
blueprint_path = root/'deploy/render.yaml'
blueprint = yaml.safe_load(blueprint_path.read_text())
Draft202012Validator.check_schema(schema)
Draft202012Validator(schema).validate(blueprint)
assert len(blueprint['services']) == 1
worker = blueprint['services'][0]
assert worker['type'] == 'worker' and worker['runtime'] == 'node'
assert worker['rootDir'] == 'packages/pricefeed' and worker['numInstances'] == 1
assert worker['autoDeployTrigger'] == 'off' and 'initialDeployHook' not in worker and 'preDeployCommand' not in worker
assert worker['disk']['mountPath'] == '/var/data' and worker['disk']['sizeGB'] == 1
assert worker['maxShutdownDelaySeconds'] == 120
env = {v['key']: v['value'] for v in worker['envVars']}
assert env['NODE_VERSION'] == '24.21.0' and env['PRICEFEED_SERVICE_PROFILE'] == '/var/data/pricefeed/profile.json'
assert worker['startCommand'] == './node_modules/.bin/node dist/scripts/render-start.js'
assert worker['buildCommand'] == 'npm ci --include=dev && ./node_modules/.bin/node node_modules/typescript/bin/tsc -p tsconfig.json'
print(json.dumps({'verified': True, 'officialSchema': schema['$id'],
                  'schemaSha256': hashlib.sha256(schema_path.read_bytes()).hexdigest(),
                  'blueprintSha256': hashlib.sha256(blueprint_path.read_bytes()).hexdigest(),
                  'accountDeploymentVerified': False, 'resourcesCreated': 0}, indent=2))
