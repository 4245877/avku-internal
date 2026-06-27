# Certificate design sources

Print-ready / vector design sources for the certificate templates.

These files are **not** used at runtime. The API renders certificates from the
PNG/JSON assets under `storage/certificates/templates/<template-id>/`
(`background.png`, `stamp-overlay.png`, `layout.json`); the PDF export is built
from the rendered PNG, not from these PDFs.

They live here (outside `storage/`) so they are kept under version control as
design history without being copied into the production runtime image. If you
update a `background.pdf`, re-export the matching `background.png` into the
corresponding `storage/.../templates/<template-id>/` directory.
