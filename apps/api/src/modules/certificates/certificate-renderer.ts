import path from "node:path";
import {
  access,
  mkdir,
  readFile,
} from "node:fs/promises";

import sharp, {
  type OverlayOptions,
} from "sharp";

import type {
  CertificateLayout,
  CertificatePhotoCrop,
  CertificatePhotoLayout,
  CertificateTextFieldLayout,
  RenderCertificateInput,
} from "./certificate.types";

const DEFAULT_PHOTO_BLEED = 2;
const DEFAULT_TEXT_WIDTH_FACTOR = 0.58;

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

function estimateTextWidth(
  value: string,
  fontSize: number,
  field: CertificateTextFieldLayout,
): number {
  const compactValue = value.trim();

  if (!compactValue) {
    return 0;
  }

  return compactValue.length * fontSize * (field.widthFactor ?? DEFAULT_TEXT_WIDTH_FACTOR);
}

function getFittedFontSize(
  value: string,
  field: CertificateTextFieldLayout,
): number {
  const baseFontSize = field.fontSize;
  const minFontSize = clamp(
    Number(field.minFontSize) || Math.round(baseFontSize * 0.48),
    12,
    baseFontSize,
  );
  const estimatedWidth = estimateTextWidth(
    value,
    baseFontSize,
    field,
  );

  if (estimatedWidth <= field.width) {
    return baseFontSize;
  }

  return Math.max(
    minFontSize,
    Math.floor((baseFontSize * field.width) / estimatedWidth),
  );
}

function createTextOverlay(
  value: string,
  field: CertificateTextFieldLayout,
): OverlayOptions {
  const safeValue = escapePango(value.trim());
  const fontSize = getFittedFontSize(
    value,
    field,
  );

  return {
    input: {
      text: {
        text: safeValue,
        font: `${field.font} ${fontSize}`,
        width: field.width,
        align: field.align ?? "left",
        wrap: "none",
        rgba: true,
      },
    },
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

  if (!(await fileExists(backgroundPath))) {
    throw new Error(
      `Не найден фон шаблона: ${backgroundPath}`,
    );
  }

  if (!(await fileExists(input.photoPath))) {
    throw new Error(
      `Не найдена фотография: ${input.photoPath}`,
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
  const layers: OverlayOptions[] = [
    {
      input: photoLayer,
      left: layout.photo.x - photoBleed,
      top: layout.photo.y - photoBleed,
    },
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
