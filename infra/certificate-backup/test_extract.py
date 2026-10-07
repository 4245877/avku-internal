import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('extract', Path(__file__).with_name('extract.py'))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)

class ExtractTests(unittest.TestCase):
    def test_rejects_all_escape_and_special_members_before_extracting(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            for index, (name, kind) in enumerate([('/absolute', tarfile.REGTYPE), ('../escape', tarfile.REGTYPE),
                      ('normal/symlink', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE), ('fifo', tarfile.FIFOTYPE)]):
                archive = root / f'{index}.tar.gz'
                with tarfile.open(archive, 'w:gz') as out:
                    entry = tarfile.TarInfo(name); entry.type = kind; entry.linkname = '../../escape'; out.addfile(entry)
                target = root / f'{index}-target'
                with self.assertRaises(ValueError): extractor.extract(archive, target)
                self.assertFalse(target.exists())

if __name__ == '__main__': unittest.main()
