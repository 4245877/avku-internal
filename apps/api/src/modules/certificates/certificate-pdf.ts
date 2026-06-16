import sharp from "sharp";

function addText(
  chunks: Buffer[],
  value: string,
): void {
  chunks.push(
    Buffer.from(
      value,
      "utf8",
    ),
  );
}

function byteLength(chunks: Buffer[]): number {
  return chunks.reduce(
    (total, chunk) => total + chunk.length,
    0,
  );
}

export async function createPdfFromPng(
  pngPath: string,
): Promise<Buffer> {
  const renderedImage = await sharp(pngPath)
    .jpeg({
      quality: 96,
      mozjpeg: true,
    })
    .toBuffer({
      resolveWithObject: true,
    });
  const { width, height } = renderedImage.info;
  const pageWidth = Number(
    ((width / 300) * 72).toFixed(2),
  );
  const pageHeight = Number(
    ((height / 300) * 72).toFixed(2),
  );
  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  const chunks: Buffer[] = [];
  const offsets = [0];

  const markObject = (objectNumber: number): void => {
    offsets[objectNumber] = byteLength(chunks);
  };

  addText(
    chunks,
    "%PDF-1.4\n",
  );

  markObject(1);
  addText(
    chunks,
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
  );

  markObject(2);
  addText(
    chunks,
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
  );

  markObject(3);
  addText(
    chunks,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );

  markObject(4);
  addText(
    chunks,
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${renderedImage.data.length} >>\nstream\n`,
  );
  chunks.push(renderedImage.data);
  addText(
    chunks,
    "\nendstream\nendobj\n",
  );

  markObject(5);
  addText(
    chunks,
    `5 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`,
  );

  const xrefOffset = byteLength(chunks);
  addText(
    chunks,
    "xref\n0 6\n0000000000 65535 f \n",
  );

  for (let objectNumber = 1; objectNumber <= 5; objectNumber += 1) {
    addText(
      chunks,
      `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`,
    );
  }

  addText(
    chunks,
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  );

  return Buffer.concat(chunks);
}
