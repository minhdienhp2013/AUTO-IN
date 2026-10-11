"""CLI example: python -m workers.documents.cli inspect file.pdf --preview-dir previews"""
import argparse
import json
from pathlib import Path
from .processor import inspect, plan


def main() -> int:
    parser = argparse.ArgumentParser(description='AUTO-IN document processor (NO PRINT)')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('inspect'); p.add_argument('file'); p.add_argument('--preview-dir')
    p = sub.add_parser('plan'); p.add_argument('plan_json', help='JSON containing files[]')
    args = parser.parse_args()
    if args.command == 'inspect':
        value = inspect(args.file, args.preview_dir)
    else:
        value = plan(json.loads(Path(args.plan_json).read_text(encoding='utf-8'))['files'])
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
