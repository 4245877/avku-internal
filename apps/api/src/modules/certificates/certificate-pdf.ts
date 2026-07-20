import sharp from "sharp";

/**
 * A single already-encoded JPEG page image plus its pixel dimensions. Pages are
 * assumed to be rendered at 300 DPI (matching the certificate render pipeline),
 * so the PDF MediaBox is derived as `pixels / 300 * 72` points.
 */
export interface PdfPageImage {
  data: Buffer;
  width: number;
  height: number;
}

const RENDER_DPI = 300;

function toPoints(pixels: number): number {
  return Number(
    ((pixels / RENDER_DPI) * 72).toFixed(2),
  );
}

/**
 * Builds a minimal PDF (one DeviceRGB/DCTDecode image per page). The object
 * layout for a single page is byte-compatible with the historical single-image
 * generator: 1 Catalog, 2 Pages, then 3 objects per page (Page, Image, Content).
 */
export function buildPdfFromImages(pages: PdfPageImage[]): Buffer {
  if (pages.length === 0) {
    throw new Error("PDF requires at least one page.");
  }

  const chunks: Buffer[] = [];
  const offsets: number[] = [0];
  const totalObjects = 2 + pages.length * 3;

  const addText = (value: string): void => {
    chunks.push(
      Buffer.from(
        value,
        "utf8",
      ),
    );
  };
  const byteLength = (): number =>
    chunks.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
  const markObject = (objectNumber: number): void => {
    offsets[objectNumber] = byteLength();
  };

  addText("%PDF-1.4\n");

  markObject(1);
  addText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  const kids = pages
    .map((_, index) => `${3 + index * 3} 0 R`)
    .join(" ");

  markObject(2);
  addText(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`,
  );

  pages.forEach((page, index) => {
    const pageNumber = 3 + index * 3;
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    const pageWidth = toPoints(page.width);
    const pageHeight = toPoints(page.height);
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;

    markObject(pageNumber);
    addText(
      `${pageNumber} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Resources << /XObject << /Im0 ${imageNumber} 0 R >> >> ` +
        `/Contents ${contentNumber} 0 R >>\nendobj\n`,
    );

    markObject(imageNumber);
    addText(
      `${imageNumber} 0 obj\n<< /Type /XObject /Subtype /Image ` +
        `/Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.data.length} >>\n` +
        "stream\n",
    );
    chunks.push(page.data);
    addText("\nendstream\nendobj\n");

    markObject(contentNumber);
    addText(
      `${contentNumber} 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\n` +
        `stream\n${content}endstream\nendobj\n`,
    );
  });

  const xrefOffset = byteLength();

  addText(`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`);

  for (let objectNumber = 1; objectNumber <= totalObjects; objectNumber += 1) {
    addText(
      `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`,
    );
  }

  addText(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF`,
  );

  return Buffer.concat(chunks);
}

/**
 * Encodes a PNG file into the JPEG page image the PDF builder embeds.
 */
export async function encodePageImage(pngPath: string): Promise<PdfPageImage> {
  const rendered = await sharp(pngPath)
    .jpeg({
      quality: 96,
      mozjpeg: true,
    })
    .toBuffer({
      resolveWithObject: true,
    });

  return {
    data: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
  };
}

export async function createPdfFromPng(
  pngPath: string,
): Promise<Buffer> {
  return buildPdfFromImages([
    await encodePageImage(pngPath),
  ]);
}
