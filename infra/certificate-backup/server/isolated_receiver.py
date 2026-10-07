#!/usr/bin/env python3
"""Test adapter only. Simulates mount verification; never use for production."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publisher.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if len(sys.argv) != 2 or not sys.argv[1].startswith('/lab/'):
    sys.exit('isolated /lab/ namespace required')
module.Publisher(Path(sys.argv[1]), lambda: None).run()
