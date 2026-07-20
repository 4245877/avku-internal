# A4 print sheet — reference sources

These are the original Photoshop/PDF mock-ups (`a4-sheet-reference.psd` /
`a4-sheet-reference.pdf`) for laying certificates out on an A4 sheet.

They are kept only as design references. The actual print sheet is generated
programmatically at 300 DPI from the already-rendered certificate cards — see
`apps/api/src/modules/certificates/certificate-print-sheet.ts` and the
`POST /api/certificates/print-sheet` endpoint. The generator produces a
two-page A4 PDF: the front page holds the main-language cards and the back page
holds the English versions, mirrored horizontally per row for duplex printing.
