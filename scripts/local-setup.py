#!/usr/bin/env python3
"""Install the local database runtime; no AWS account or credentials needed."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tarfile
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'
URL = 'https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz'


def main():
    subprocess.run(['java', '-version'], check=True, capture_output=True)
    LOCAL.mkdir(mode=0o700, exist_ok=True)
    LOCAL.chmod(0o700)
    runtime = LOCAL / 'runtime'
    if not (runtime / 'DynamoDBLocal.jar').exists() or not (runtime / 'install.json').exists():
        print('Downloading DynamoDB Local from AWS…', flush=True)
        with tempfile.TemporaryDirectory(dir=LOCAL) as temporary:
            archive = Path(temporary) / 'dynamodb.tar.gz'
            with urlopen(URL, timeout=60) as response, archive.open('wb') as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
            with urlopen(URL + '.sha256', timeout=30) as response:
                expected = response.read().decode().split()[0]
            checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
            if checksum != expected:
                raise RuntimeError('DynamoDB Local checksum mismatch; installation stopped.')
            runtime.mkdir(exist_ok=True)
            with tarfile.open(archive) as bundle:
                bundle.extractall(runtime, filter='data')
            (runtime / 'install.json').write_text(json.dumps({'url': URL, 'sha256': checksum}, indent=2))
        print('DynamoDB Local archive verified and installed.')
    password = LOCAL / 'admin-password'
    if not password.exists():
        descriptor = os.open(password, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as target:
            target.write(secrets.token_urlsafe(24) + '\n')
    password.chmod(0o600)
    print('Local setup ready. Your admin password is in .local/admin-password (not printed).')
    print('Run npm run dev:web to start the website.')


if __name__ == '__main__':
    main()
