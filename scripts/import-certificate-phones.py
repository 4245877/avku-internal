#!/usr/bin/env python3
"""Conservative DOCX phone import using only Python's standard library.

Dry run is the default. Reports and SQLite online backups contain personal data
and belong in private, git-ignored storage, never in web/public or an export.
"""

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import unicodedata
import xml.etree.ElementTree as ET
import zipfile


NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
CYRILLIC = re.compile(r"[А-Яа-яІіЇїЄєҐґ]")


def canonical_number(value):
    text = unicodedata.normalize("NFKC", value).strip()
    return str(int(text)) if re.fullmatch(r"[0-9]+", text) else text.casefold()


def name_parts(value):
    # Latin transliterations sometimes follow the Cyrillic name without a space.
    line = next((s for s in value.splitlines() if CYRILLIC.search(s)), "")
    line = re.split(r"[A-Za-z]", line, maxsplit=1)[0]
    line = unicodedata.normalize("NFKC", line).casefold()
    line = re.sub(r"['’ʼ`\u02b9]", "", line)
    return re.findall(r"[а-яіїєґ]+(?:-[а-яіїєґ]+)*", line)


def parse_phones(raw):
    if not raw.strip():
        return None, "no_phone"
    result, seen = [], set()
    for part in re.split(r"[\n\r;,/]+", raw):
        value = " ".join(part.split())
        if not value:
            continue
        if not re.fullmatch(r"\+?[0-9][0-9 ()-]*", value):
            return None, "malformed_phone"
        digits = re.sub(r"[^0-9]", "", value)
        if not 7 <= len(digits) <= 15:
            return None, "incomplete_phone"
        if (value.startswith("+380") and len(digits) != 12) or (
            value.startswith("0") and not value.startswith("00") and len(digits) != 10
        ):
            return None, "malformed_phone"
        if digits not in seen:
            result.append(value)
            seen.add(digits)
    return ("; ".join(result), "valid_phone") if result else (None, "no_phone")


def read_document(document):
    with zipfile.ZipFile(document) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    entries, skipped = [], Counter()
    for table_index, table in enumerate(root.findall(".//w:tbl", NS), 1):
        for row_index, row in enumerate(table.findall("w:tr", NS), 1):
            cells = [
                "\n".join(
                    "".join(t.text or "" for t in p.findall(".//w:t", NS))
                    for p in cell.findall("w:p", NS)
                ).strip()
                for cell in row.findall("w:tc", NS)
            ]
            if len(cells) != 5:
                raise ValueError(f"Unexpected DOCX structure at table {table_index}, row {row_index}")
            number, name, _, _, raw_phone = cells
            if "sertificate" in number.casefold() or "псвдч" in number.casefold():
                skipped["headers"] += 1
                continue
            if not number and not name:
                skipped["empty_or_template_rows"] += 1
                # Preserve real contact data even when both identifiers are absent.
                if parse_phones(raw_phone)[0] is None:
                    continue
            phone, phone_status = parse_phones(raw_phone)
            entries.append({
                "table": table_index, "row": row_index,
                "certificate_number": number, "source_name": name,
                "raw_phone": raw_phone, "phone_number": phone,
                "phone_status": phone_status,
            })
    if not entries:
        raise ValueError("No certificate entries found in DOCX")
    return entries, dict(skipped)


def read_records(database):
    return [dict(row) for row in database.execute("SELECT * FROM certificate_records ORDER BY id")]


def build_plan(entries, records):
    by_number, by_pair = defaultdict(list), defaultdict(list)
    source_numbers = Counter(canonical_number(e["certificate_number"]) for e in entries)
    for record in records:
        by_number[canonical_number(record["certificate_number"])].append(record)
        by_pair[tuple(name_parts(record["full_name"])[:2])].append(record)
    plan = []
    for entry in entries:
        item = dict(entry)
        number = canonical_number(entry["certificate_number"])
        source_name = name_parts(entry["source_name"])
        candidates = by_number.get(number, [])
        item["candidates"] = [
            {k: record[k] for k in ("id", "certificate_number", "full_name")}
            for record in (candidates or by_pair.get(tuple(source_name[:2]), []))
        ]
        if not number or len(source_name) < 2:
            identity = "missing_identity"
        elif source_numbers[number] > 1:
            identity = "duplicate_source_number"
        elif not candidates:
            identity = "number_not_found"
        elif len(candidates) != 1:
            identity = "ambiguous_database_number"
        else:
            target_name = name_parts(candidates[0]["full_name"])
            exact = source_name == target_name or (
                len(source_name) >= 3 and len(target_name) >= 2
                and "".join(source_name) == "".join(target_name)
            )
            partial = (
                min(len(source_name), len(target_name)) == 2
                and source_name[:2] == target_name[:2]
                and len(by_pair[tuple(target_name[:2])]) == 1
            )
            identity = "matched" if exact or partial else "name_conflict"
            if identity == "matched":
                item["record_id"] = candidates[0]["id"]
                item["match_method"] = "number_and_full_name" if exact else "number_and_unique_name_pair"
                existing = candidates[0].get("phone_number")
                if existing and item["phone_number"] and existing != item["phone_number"]:
                    item["action"] = "existing_phone_conflict"
                else:
                    item["action"] = (
                        "update" if item["phone_number"] and existing != item["phone_number"]
                        else "already_present" if item["phone_number"] else "leave_empty"
                    )
        item["identity_status"] = identity
        if identity != "matched":
            item["action"] = "manual_review"
        plan.append(item)
    return plan


def verify_only_phones_changed(before, after):
    def without_phone(rows):
        return [{k: v for k, v in r.items() if k != "phone_number"} for r in rows]
    if without_phone(before) != without_phone(after):
        raise RuntimeError("An existing certificate field changed; import rolled back")


def import_phones(document, database_path, report_dir, backup_dir, apply=False):
    os.umask(0o077)
    document, database_path = Path(document).resolve(), Path(database_path).resolve()
    entries, skipped = read_document(document)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    report_dir, backup_dir = Path(report_dir), Path(backup_dir)
    report_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    database = sqlite3.connect(database_path.as_uri() + ("?mode=rw" if apply else "?mode=ro"), uri=True)
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA busy_timeout = 10000")
    backup_path = None
    report_path = None
    try:
        if apply:
            if database.execute("PRAGMA user_version").fetchone()[0] < 4:
                raise ValueError("Run the application's existing draft migration before importing phones")
            backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            backup_path = backup_dir / f"certificates-before-phones-{stamp}.sqlite"
            # Online backup includes committed WAL pages; a file copy would not.
            with closing(sqlite3.connect(backup_path)) as backup:
                database.backup(backup)
                if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("Backup integrity check failed")
            database.execute("BEGIN IMMEDIATE")
        else:
            database.execute("BEGIN")
        before = read_records(database)
        plan = build_plan(entries, before)
        if apply:
            columns = {row["name"] for row in database.execute("PRAGMA table_info(certificate_records)")}
            if "phone_number" not in columns:
                database.execute("ALTER TABLE certificate_records ADD COLUMN phone_number TEXT")
            for item in plan:
                if item["action"] == "update":
                    changed = database.execute(
                        "UPDATE certificate_records SET phone_number = ? WHERE id = ? AND phone_number IS NULL",
                        (item["phone_number"], item["record_id"]),
                    ).rowcount
                    if changed != 1:
                        raise RuntimeError("Concurrent/existing phone change; import rolled back")
            # Additive v4 extension: preserve compatibility with backup readers.
        after = read_records(database)
        verify_only_phones_changed(before, after)
        if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Database integrity check failed")
        expected = {item["record_id"]: item["phone_number"] for item in plan if item["action"] == "update"}
        if apply and any(row.get("phone_number") != expected[row["id"]] for row in after if row["id"] in expected):
            raise RuntimeError("Phone verification failed")
        matched_ids = {item["record_id"] for item in plan if item["identity_status"] == "matched"}
        summary = {
            "mode": "apply" if apply else "dry_run", "database_records": len(before),
            "document_records": len(entries), "skipped_rows": skipped,
            "document_phone_numbers": sum(len(e["phone_number"].split("; ")) for e in entries if e["phone_number"]),
            "identity_statuses": dict(Counter(item["identity_status"] for item in plan)),
            "phone_statuses": dict(Counter(item["phone_status"] for item in plan)),
            "actions": dict(Counter(item["action"] for item in plan)),
            "updated_records": len(expected) if apply else 0,
            "records_with_phone": sum(bool(row.get("phone_number")) for row in after),
            "records_without_phone": sum(not row.get("phone_number") for row in after),
            "existing_fields_unchanged": True, "integrity_check": "ok",
        }
        report = {
            "created_at_utc": stamp, "document": str(document),
            "document_sha256": hashlib.sha256(document.read_bytes()).hexdigest(),
            "database": str(database_path), "backup": str(backup_path) if backup_path else None,
            "summary": summary, "entries": plan,
            "database_records_without_document_match": [
                {k: row[k] for k in ("id", "certificate_number", "full_name")}
                for row in before if row["id"] not in matched_ids
            ],
        }
        report_path = report_dir / f"phone-import-{stamp}.json"
        # Failure to persist the audit report must also prevent a bulk commit.
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        database.commit()
        return report, report_path
    except BaseException:
        database.rollback()
        if report_path is not None:
            report_path.unlink(missing_ok=True)
        raise
    finally:
        database.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--document", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--report-dir", type=Path, default=Path("storage/certificates/import-reports"))
    parser.add_argument("--backup-dir", type=Path, default=Path("storage/backups/certificate-phones"))
    parser.add_argument("--apply", action="store_true", help="Back up, migrate, then import in one transaction")
    args = parser.parse_args()
    report, report_path = import_phones(args.document, args.database, args.report_dir, args.backup_dir, args.apply)
    print(json.dumps({**report["summary"], "backup": report["backup"], "report": str(report_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
