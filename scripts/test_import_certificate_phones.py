import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile


spec = importlib.util.spec_from_file_location("phones", Path(__file__).with_name("import-certificate-phones.py"))
phones = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phones)


class PhoneImportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / "certificates.sqlite"
        with closing(sqlite3.connect(self.db)) as db:
            db.executescript("""
                CREATE TABLE certificate_records (
                  id TEXT PRIMARY KEY, certificate_number TEXT, full_name TEXT,
                  created_at TEXT, updated_at TEXT
                );
                PRAGMA user_version=4;
                INSERT INTO certificate_records VALUES ('a','001','Іваненко Іван Іванович','created','unchanged');
                INSERT INTO certificate_records VALUES ('b','002','Петренко Петро Петрович','created','unchanged');
            """)

    def document(self, rows):
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        root = ET.Element(ns + "document")
        table = ET.SubElement(ET.SubElement(root, ns + "body"), ns + "tbl")
        for number, name, phone in rows:
            row = ET.SubElement(table, ns + "tr")
            for value in [number, name, "", "", phone]:
                cell = ET.SubElement(row, ns + "tc")
                for line in value.split("\n"):
                    ET.SubElement(ET.SubElement(ET.SubElement(cell, ns + "p"), ns + "r"), ns + "t").text = line
        doc = self.root / "source.docx"
        with zipfile.ZipFile(doc, "w") as archive:
            archive.writestr("word/document.xml", ET.tostring(root))
        return doc

    def run_import(self, rows, apply=False):
        return phones.import_phones(self.document(rows), self.db, self.root / "reports", self.root / "backups", apply)[0]

    def test_phone_strings_preserve_plus_zero_and_multiple_contacts(self):
        self.assertEqual(phones.parse_phones("+380 (67) 001-02-03\n0033123456789")[0],
                         "+380 (67) 001-02-03; 0033123456789")
        for raw in ["", "+38", "+380", "+380506+456057"]:
            self.assertIsNone(phones.parse_phones(raw)[0])

    def test_dry_run_does_not_migrate_or_update_database(self):
        before = self.db.read_bytes()
        report = self.run_import([("001", "Іваненко Іван Іванович", "+380670010203")])
        self.assertEqual(report["summary"]["actions"]["update"], 1)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertFalse((self.root / "backups").exists())

    def test_apply_backs_up_changes_only_phone_and_is_idempotent(self):
        rows = [("0001", "Іваненко Іван\nIvan Ivanenko", "+380670010203\n+380990010203"),
                ("002", "Петренко Петро Петрович", "+380")]
        report = self.run_import(rows, apply=True)
        with closing(sqlite3.connect(report["backup"])) as backup:
            self.assertNotIn("phone_number", [r[1] for r in backup.execute("PRAGMA table_info(certificate_records)")])
            self.assertEqual(backup.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT phone_number,updated_at FROM certificate_records ORDER BY id").fetchall(),
                             [("+380670010203; +380990010203", "unchanged"), (None, "unchanged")])
        self.assertEqual(report["summary"]["updated_records"], 1)
        repeated = self.run_import(rows, apply=True)
        self.assertEqual(repeated["summary"]["updated_records"], 0)
        self.assertEqual(repeated["summary"]["actions"]["already_present"], 1)

    def test_conflicts_duplicates_and_other_numbers_require_manual_review(self):
        report = self.run_import([
            ("001", "Інший Іван Іванович", "+380670010203"),
            ("002", "Петренко Петро Петрович", "+380670010204"),
            ("002", "Інший Петро Петрович", "+380670010205"),
            ("003", "Іваненко Іван Іванович", "+380670010206"),
        ], apply=True)
        self.assertEqual(report["summary"]["updated_records"], 0)
        self.assertEqual(report["summary"]["actions"]["manual_review"], 4)
        self.assertEqual(report["summary"]["records_without_phone"], 2)

    def test_existing_phone_is_never_overwritten(self):
        self.run_import([("001", "Іваненко Іван Іванович", "+380670010203")], apply=True)
        report = self.run_import([("001", "Іваненко Іван Іванович", "+380990010203")], apply=True)
        self.assertEqual(report["summary"]["actions"]["existing_phone_conflict"], 1)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT phone_number FROM certificate_records WHERE id='a'").fetchone()[0], "+380670010203")

    def test_missing_audit_report_rolls_back_schema_and_values(self):
        with patch.object(Path, "write_text", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.run_import([("001", "Іваненко Іван Іванович", "+380670010203")], apply=True)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertNotIn("phone_number", [r[1] for r in db.execute("PRAGMA table_info(certificate_records)")])
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 4)


if __name__ == "__main__":
    unittest.main()
