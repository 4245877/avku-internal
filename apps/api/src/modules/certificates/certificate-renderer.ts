import path from "node:path";
import {
  access,
  mkdir,
  readFile,
} from "node:fs/promises";

import sharp from "sharp";

type OverlayOptions = sharp.OverlayOptions;

import type {
  CertificateLayout,
  CertificatePhotoCrop,
  CertificatePhotoLayout,
  CertificateTextFieldLayout,
  RenderCertificateInput,
} from "./certificate.types";

const DEFAULT_PHOTO_BLEED = 2;

interface RenderedTextBitmap {
  buffer: Buffer;
  width: number;
  height: number;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapePango(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatDate(value: string): string {
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!isoDate) {
    return value;
  }

  const [, year, month, day] = isoDate;

  return `${day}.${month}.${year}`;
}

function getPhotoBleed(
  photo: CertificatePhotoLayout,
): number {
  return clamp(
    Number(photo.bleed ?? DEFAULT_PHOTO_BLEED) || 0,
    0,
    8,
  );
}

function getTextAlign(
  field: CertificateTextFieldLayout,
): "left" | "center" | "right" {
  if (field.align === "right") {
    return "right";
  }

  if (field.align === "center" || field.align === "centre") {
    return "center";
  }

  return "left";
}

function getAlignedOffset(
  containerWidth: number,
  contentWidth: number,
  align: "left" | "center" | "right",
): number {
  const availableSpace = Math.max(
    0,
    containerWidth - contentWidth,
  );

  if (align === "right") {
    return availableSpace;
  }

  if (align === "center") {
    return Math.round(availableSpace / 2);
  }

  return 0;
}

async function renderTextBitmap(
  value: string,
  field: CertificateTextFieldLayout,
  fontSize: number,
): Promise<RenderedTextBitmap> {
  const safeValue = escapePango(value.trim());
  const buffer = await sharp({
    text: {
      text: safeValue,
      font: `${field.font} ${fontSize}`,
      wrap: "none",
      rgba: true,
    },
  })
    .png()
    .toBuffer();
  const metadata = await sharp(buffer).metadata();

  return {
    buffer,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
}

function doesTextFitField(
  bitmap: RenderedTextBitmap,
  field: CertificateTextFieldLayout,
): boolean {
  return bitmap.width <= field.width && bitmap.height <= field.height;
}

async function getFittedTextBitmap(
  value: string,
  field: CertificateTextFieldLayout,
): Promise<RenderedTextBitmap> {
  const baseFontSize = field.fontSize;
  const minFontSize = clamp(
    Number(field.minFontSize) || Math.round(baseFontSize * 0.48),
    1,
    baseFontSize,
  );
  const baseBitmap = await renderTextBitmap(
    value,
    field,
    baseFontSize,
  );

  if (doesTextFitField(
    baseBitmap,
    field,
  )) {
    return baseBitmap;
  }

  let bestBitmap = await renderTextBitmap(
    value,
    field,
    minFontSize,
  );
  let low = minFontSize + 1;
  let high = baseFontSize - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const bitmap = await renderTextBitmap(
      value,
      field,
      mid,
    );

    if (doesTextFitField(
      bitmap,
      field,
    )) {
      bestBitmap = bitmap;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestBitmap.height > field.height) {
    const fittedBuffer = await sharp(bestBitmap.buffer)
      .resize({
        height: field.height,
        fit: "inside",
      })
      .png()
      .toBuffer();
    const metadata = await sharp(fittedBuffer).metadata();

    bestBitmap = {
      buffer: fittedBuffer,
      width: metadata.width ?? bestBitmap.width,
      height: metadata.height ?? field.height,
    };
  }

  if (bestBitmap.width <= field.width) {
    return bestBitmap;
  }

  const fittedBuffer = await sharp(bestBitmap.buffer)
    .resize({
      width: field.width,
      height: bestBitmap.height,
      fit: "fill",
    })
    .png()
    .toBuffer();
  const metadata = await sharp(fittedBuffer).metadata();

  return {
    buffer: fittedBuffer,
    width: metadata.width ?? field.width,
    height: metadata.height ?? bestBitmap.height,
  };
}

async function createTextFieldLayer(
  value: string,
  field: CertificateTextFieldLayout,
): Promise<Buffer> {
  const layerWidth = Math.max(
    1,
    Math.round(field.width),
  );
  const layerHeight = Math.max(
    1,
    Math.round(field.height),
  );
  const emptyLayer = sharp({
    create: {
      width: layerWidth,
      height: layerHeight,
      channels: 4,
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
      },
    },
  });
  const text = value.trim();

  if (!text) {
    return emptyLayer
      .png()
      .toBuffer();
  }

  const bitmap = await getFittedTextBitmap(
    text,
    field,
  );
  const align = getTextAlign(field);

  return emptyLayer
    .composite([
      {
        input: bitmap.buffer,
        left: getAlignedOffset(
          layerWidth,
          bitmap.width,
          align,
        ),
        top: clamp(
          Math.round((layerHeight - bitmap.height) / 2),
          0,
          Math.max(0, layerHeight - bitmap.height),
        ),
      },
    ])
    .png()
    .toBuffer();
}

async function createTextOverlay(
  value: string,
  field: CertificateTextFieldLayout,
): Promise<OverlayOptions> {
  return {
    input: await createTextFieldLayer(
      value,
      field,
    ),
    left: field.x,
    top: field.y,
  };
}

function clamp(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(
    Math.max(value, min),
    max,
  );
}

function normalizeCrop(
  crop?: Partial<CertificatePhotoCrop>,
): CertificatePhotoCrop {
  return {
    zoom: clamp(
      Number(crop?.zoom) || 1,
      1,
      3,
    ),
    offsetX: Number(crop?.offsetX) || 0,
    offsetY: Number(crop?.offsetY) || 0,
  };
}

function getOrientedSize(
  metadata: sharp.Metadata,
): { width: number; height: number } {
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const shouldSwap =
    typeof metadata.orientation === "number" &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8;

  return shouldSwap
    ? {
      width: height,
      height: width,
    }
    : {
      width,
      height,
    };
}

async function createPhotoLayer(
  photoPath: string,
  layout: CertificateLayout,
  crop?: Partial<CertificatePhotoCrop>,
): Promise<Buffer> {
  const { width, height, radius } = layout.photo;
  const bleed = getPhotoBleed(layout.photo);
  const targetWidth = width + bleed * 2;
  const targetHeight = height + bleed * 2;
  const metadata = await sharp(photoPath).metadata();
  const imageSize = getOrientedSize(metadata);
  const safeCrop = normalizeCrop(crop);
  const scale = Math.max(
    targetWidth / imageSize.width,
    targetHeight / imageSize.height,
  ) * safeCrop.zoom;
  const resizedWidth = Math.max(
    targetWidth,
    Math.round(imageSize.width * scale),
  );
  const resizedHeight = Math.max(
    targetHeight,
    Math.round(imageSize.height * scale),
  );
  const extractLeft = clamp(
    Math.round((resizedWidth - targetWidth) / 2 - safeCrop.offsetX),
    0,
    Math.max(0, resizedWidth - targetWidth),
  );
  const extractTop = clamp(
    Math.round((resizedHeight - targetHeight) / 2 - safeCrop.offsetY),
    0,
    Math.max(0, resizedHeight - targetHeight),
  );
  const roundedMask = Buffer.from(`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${targetWidth}"
      height="${targetHeight}"
      viewBox="0 0 ${targetWidth} ${targetHeight}"
    >
      <rect
        x="0"
        y="0"
        width="${targetWidth}"
        height="${targetHeight}"
        rx="${radius + bleed}"
        ry="${radius + bleed}"
        fill="#ffffff"
      />
    </svg>
  `);

  return sharp(photoPath)
    .autoOrient()
    .resize(resizedWidth, resizedHeight, {
      fit: "fill",
    })
    .extract({
      left: extractLeft,
      top: extractTop,
      width: targetWidth,
      height: targetHeight,
    })
    .composite([
      {
        input: roundedMask,
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
}

async function readLayout(
  templateDirectory: string,
): Promise<CertificateLayout> {
  const layoutPath = path.join(
    templateDirectory,
    "layout.json",
  );
  const content = await readFile(layoutPath, "utf8");

  return JSON.parse(
    content.replace(/^\uFEFF/, ""),
  ) as CertificateLayout;
}

async function createStampOverlay(
  stampOverlayPath: string,
  layout: CertificateLayout,
): Promise<OverlayOptions | null> {
  if (!(await fileExists(stampOverlayPath))) {
    return null;
  }

  const stampMetadata = await sharp(stampOverlayPath).metadata();
  const isFullCanvasOverlay =
    stampMetadata.width === layout.canvas.width &&
    stampMetadata.height === layout.canvas.height;

  if (isFullCanvasOverlay) {
    return {
      input: stampOverlayPath,
      left: 0,
      top: 0,
    };
  }

  if (!layout.stampOverlay) {
    throw new Error(
      [
        "Для stamp-overlay.png меньшего размера нужна секция stampOverlay в layout.json.",
        `Размер stamp-overlay.png: ${stampMetadata.width}x${stampMetadata.height}.`,
      ].join(" "),
    );
  }

  return {
    input: await sharp(stampOverlayPath)
      .resize(
        layout.stampOverlay.width,
        layout.stampOverlay.height,
        {
          fit: "fill",
        },
      )
      .png()
      .toBuffer(),
    left: layout.stampOverlay.x,
    top: layout.stampOverlay.y,
  };
}

export async function renderCertificate(
  input: RenderCertificateInput,
): Promise<string> {
  const backgroundPath = path.join(
    input.templateDirectory,
    "background.png",
  );
  const stampOverlayPath = path.join(
    input.templateDirectory,
    "stamp-overlay.png",
  );

  // Only surface non-sensitive identifiers in error messages: these bubble up
  // to API responses, so absolute filesystem paths must never be embedded here.
  const templateId = path.basename(input.templateDirectory);

  if (!(await fileExists(backgroundPath))) {
    throw new Error(
      `Не найден фон шаблона «${templateId}».`,
    );
  }

  if (!(await fileExists(input.photoPath))) {
    throw new Error(
      "Не найдена фотография посвідчення.",
    );
  }

  const layout = await readLayout(
    input.templateDirectory,
  );
  const backgroundMetadata = await sharp(
    backgroundPath,
  ).metadata();

  if (
    backgroundMetadata.width !== layout.canvas.width ||
    backgroundMetadata.height !== layout.canvas.height
  ) {
    throw new Error(
      [
        "Неверный размер background.png.",
        `Ожидается: ${layout.canvas.width}x${layout.canvas.height}.`,
        `Получено: ${backgroundMetadata.width}x${backgroundMetadata.height}.`,
      ].join(" "),
    );
  }

  const photoLayer = await createPhotoLayer(
    input.photoPath,
    layout,
    input.photoCrop,
  );
  const photoBleed = getPhotoBleed(layout.photo);
  const fullName = [
    input.firstName,
    input.middleName,
  ]
    .filter(Boolean)
    .join(" ");
  const textLayers = await Promise.all([
    createTextOverlay(
      input.lastName,
      layout.fields.lastName,
    ),
    createTextOverlay(
      fullName,
      layout.fields.fullName,
    ),
    createTextOverlay(
      input.certificateNumber,
      layout.fields.certificateNumber,
    ),
    ...(input.issuedAt && layout.fields.issuedAt
      ? [
        createTextOverlay(
          formatDate(input.issuedAt),
          layout.fields.issuedAt,
        ),
      ]
      : []),
    createTextOverlay(
      formatDate(input.validUntil),
      layout.fields.validUntil,
    ),
  ]);
  const layers: OverlayOptions[] = [
    {
      input: photoLayer,
      left: layout.photo.x - photoBleed,
      top: layout.photo.y - photoBleed,
    },
    ...textLayers,
  ];
  const stampOverlay = await createStampOverlay(
    stampOverlayPath,
    layout,
  );

  if (stampOverlay) {
    layers.push(stampOverlay);
  }

  await mkdir(
    path.dirname(input.outputPath),
    {
      recursive: true,
    },
  );

  await sharp(backgroundPath)
    .composite(layers)
    .png({
      compressionLevel: 9,
    })
    .withMetadata({
      density: 300,
    })
    .toFile(input.outputPath);

  return input.outputPath;
}
