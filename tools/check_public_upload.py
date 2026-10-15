"""Audit Git's index before publishing this repository.

The check reports file names and issue types only; it never prints matched data.
"""

from pathlib import PurePosixPath
import re
import subprocess
import sys


PRIVATE_PARTS = {'data', 'attachments', 'backups', 'qa-artifacts', 'exports', '.opencode', '.codex', '.agents'}
PRIVATE_NAMES = {
    'llm-config.json', 'llm-config.local.json', 'serverchan-config.json',
    'opencode.json', 'opencode.jsonc', 'auth.json', 'service.json', '.env',
}
PRIVATE_SUFFIXES = {'.sqlite', '.sqlite3', '.db', '.db3', '.pem', '.p12', '.pfx', '.log', '.jsonl'}
KEY_PATTERNS = {
    'ServerChan SendKey': re.compile(rb'SCT[A-Za-z0-9]{25,}'),
    'API key': re.compile(rb'sk-[A-Za-z0-9_-]{20,}'),
    'AWS access key': re.compile(rb'AKIA[0-9A-Z]{16}'),
    'Google API key': re.compile(rb'AIza[0-9A-Za-z_-]{35}'),
    'private key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
}


def private_path(name):
    path = PurePosixPath(name)
    basename = path.name.lower()
    if any(part.lower() in PRIVATE_PARTS for part in path.parts):
        return 'private data directory'
    if basename in PRIVATE_NAMES or basename.startswith('.env.'):
        return 'private configuration file'
    if path.suffix.lower() in PRIVATE_SUFFIXES:
        return 'private data or credential file type'
    if re.search(r'(?:backup|export).*\.json$', basename, re.I):
        return 'export or backup file'
    if path.suffix.lower() == '.json' and not basename.endswith('.example.json'):
        return 'JSON file needs an explicit public example review'
    return ''


def git(*args):
    return subprocess.run(['git', *args], check=True, stdout=subprocess.PIPE).stdout


def main():
    root = git('rev-parse', '--show-toplevel').decode('utf-8').strip()
    names = [item.decode('utf-8') for item in git('-C', root, 'ls-files', '-z').split(b'\0') if item]
    findings = []
    for name in names:
        reason = private_path(name)
        if reason:
            findings.append((name, reason))
            continue
        content = git('-C', root, 'show', ':' + name)
        for label, pattern in KEY_PATTERNS.items():
            if pattern.search(content):
                findings.append((name, label))
    if findings:
        for name, reason in findings:
            print(f'BLOCKED: {name}: {reason}')
        return 1
    print(f'Public upload check passed for {len(names)} staged/tracked files.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
