#!/usr/bin/env python3
"""Generate the pinned TypeScript and PostgreSQL Unicode case-fold artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import unicodedata


UNICODE_VERSION = "16.0.0"
EXPECTED_ENTRY_COUNT = 1_557
EXPECTED_SHA256 = "3665d2456dc5fa6295527b8fe486e5a100cd898ab02585ec09b6db4b4244ab50"
SQL_BEGIN = "-- BEGIN GENERATED UNICODE 16.0 DEFAULT CASE FOLD"
SQL_END = "-- END GENERATED UNICODE 16.0 DEFAULT CASE FOLD"


def case_fold_rows() -> list[tuple[int, str]]:
    rows: list[tuple[int, str]] = []
    for code_point in range(0x110000):
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        scalar = chr(code_point)
        folded = scalar.casefold()
        if folded != scalar:
            rows.append((code_point, folded))
    return rows


def canonical_mapping(rows: list[tuple[int, str]]) -> bytes:
    return "".join(
        f'{code_point:06X};{" ".join(f"{ord(scalar):06X}" for scalar in folded)}\n'
        for code_point, folded in rows
    ).encode("utf-8")


def validated_rows() -> tuple[list[tuple[int, str]], str]:
    if unicodedata.unidata_version != UNICODE_VERSION:
        raise RuntimeError(
            f"Python Unicode data {unicodedata.unidata_version} does not match {UNICODE_VERSION}."
        )

    rows = case_fold_rows()
    checksum = hashlib.sha256(canonical_mapping(rows)).hexdigest()
    if len(rows) != EXPECTED_ENTRY_COUNT or checksum != EXPECTED_SHA256:
        raise RuntimeError(
            f"Unexpected mapping invariant: count={len(rows)}, sha256={checksum}."
        )
    return rows, checksum


def render() -> str:
    rows, checksum = validated_rows()

    lines = [
        "// GENERATED FILE — DO NOT EDIT BY HAND.",
        "// Python 3.14 unicodedata 16.0.0 str.casefold(); Unicode CaseFolding status C+F, Turkic T excluded.",
        "// Regenerate: python3 scripts/generate-unicode-case-fold.py --write server/src/services/unicodeCaseFold.ts",
        "// Verify: python3 scripts/generate-unicode-case-fold.py --check server/src/services/unicodeCaseFold.ts",
        "// Canonical checksum rows use 6-digit uppercase scalar hex, a semicolon, fold scalars, then newline.",
        "",
        f"export const UNICODE_CASE_FOLD_VERSION = '{UNICODE_VERSION}';",
        f"export const UNICODE_CASE_FOLD_ENTRY_COUNT = {EXPECTED_ENTRY_COUNT:_};",
        f"export const UNICODE_CASE_FOLD_SHA256 = '{checksum}';",
        "",
        "export const UNICODE_CASE_FOLD_ENTRIES: readonly (readonly [number, string])[] = [",
    ]
    lines.extend(
        f"  [0x{code_point:06x}, {json.dumps(folded, ensure_ascii=True)}],"
        for code_point, folded in rows
    )
    lines.extend(
        [
            "];",
            "",
            "const unicodeCaseFoldMap = new Map<number, string>(UNICODE_CASE_FOLD_ENTRIES);",
            "",
            "export function foldUnicodeDefaultCase(value: string): string {",
            "  const foldedScalars: string[] = [];",
            "  for (const scalar of value) {",
            "    const codePoint = scalar.codePointAt(0)!;",
            "    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {",
            "      throw new TypeError('Unicode case-fold input must contain only scalar values.');",
            "    }",
            "    foldedScalars.push(unicodeCaseFoldMap.get(codePoint) ?? scalar);",
            "  }",
            "  return foldedScalars.join('');",
            "}",
            "",
        ]
    )
    return "\n".join(lines)


def unicode_sql_literal(value: str) -> str:
    escaped = "".join(
        f"\\{ord(scalar):04X}"
        if ord(scalar) <= 0xFFFF
        else f"\\+{ord(scalar):06X}"
        for scalar in value
    )
    return f"U&'{escaped}'"


def render_sql() -> str:
    rows, checksum = validated_rows()
    lines = [
        SQL_BEGIN,
        "-- GENERATED — DO NOT EDIT BY HAND.",
        f"-- Unicode {UNICODE_VERSION} CaseFolding status C+F, Turkic T excluded.",
        f"-- Entries: {EXPECTED_ENTRY_COUNT}; canonical SHA-256: {checksum}.",
        "-- Regenerate: python3 scripts/generate-unicode-case-fold.py --write-sql prisma/migrations/20260904090000_expand_two_state_rules/migration.sql",
        "-- Verify: python3 scripts/generate-unicode-case-fold.py --check-sql prisma/migrations/20260904090000_expand_two_state_rules/migration.sql",
        "CREATE OR REPLACE FUNCTION rule_unicode_case_fold_16_0(input_value text)",
        "RETURNS text",
        "LANGUAGE sql",
        "IMMUTABLE",
        "STRICT",
        "PARALLEL SAFE",
        "SET search_path = pg_catalog, public",
        "AS $casefold$",
        "  SELECT COALESCE(",
        "    string_agg(",
        "      CASE ascii(scalar_value)",
    ]
    lines.extend(
        f"        WHEN {code_point} THEN {unicode_sql_literal(folded)}"
        for code_point, folded in rows
    )
    lines.extend([
        "        ELSE scalar_value",
        "      END,",
        "      '' ORDER BY ordinal",
        "    ),",
        "    ''",
        "  )",
        "  FROM unnest(string_to_array(input_value, NULL))",
        "       WITH ORDINALITY AS characters(scalar_value, ordinal);",
        "$casefold$;",
        SQL_END,
    ])
    return "\n".join(lines)


def replace_sql_artifact(path: Path, generated: str) -> str:
    actual = path.read_text(encoding="utf-8")
    start = actual.find(SQL_BEGIN)
    end = actual.find(SQL_END)
    if start < 0 or end < start:
        raise RuntimeError(f"{path} does not contain the SQL generation markers.")
    end += len(SQL_END)
    return actual[:start] + generated + actual[end:]


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", type=Path, metavar="PATH")
    mode.add_argument("--check", type=Path, metavar="PATH")
    mode.add_argument("--write-sql", type=Path, metavar="MIGRATION")
    mode.add_argument("--check-sql", type=Path, metavar="MIGRATION")
    args = parser.parse_args()

    if args.write is not None:
        args.write.write_text(render(), encoding="utf-8")
        return 0
    if args.check is not None:
        actual = args.check.read_text(encoding="utf-8")
        if actual != render():
            print(f"{args.check} is not the pinned generated output.", file=sys.stderr)
            return 1
        return 0
    if args.write_sql is not None:
        args.write_sql.write_text(
            replace_sql_artifact(args.write_sql, render_sql()),
            encoding="utf-8",
        )
        return 0

    actual = args.check_sql.read_text(encoding="utf-8")
    if replace_sql_artifact(args.check_sql, render_sql()) != actual:
        print(f"{args.check_sql} does not contain the pinned generated SQL output.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
