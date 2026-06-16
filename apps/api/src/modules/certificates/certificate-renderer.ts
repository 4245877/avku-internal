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
  CertificateTextFieldLayout,
  RenderCertificateInput,
} from "./certificate.types";

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

function createTextOverlay(
  value: string,
  field: CertificateTextFieldLayout,
): OverlayOptions {
  const safeValue = escapePango(value.trim());

  return {
    input: {
      text: {
        text: safeValue,
        font: `${field.font} ${field.fontSize}`,
        width: field.width,
        height: field.height,
        align: field.align ?? "left",
        rgba: true,
      },
    },
    left: field.x,
    top: field.y,
  };
}

async function createPhotoLayer(
  photoPath: string,
  layout: CertificateLayout,
): Promise<Buffer> {
  const { width, height, radius } = layout.photo;

  const roundedMask = Buffer.from(`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}"
    >
      <rect
        x="0"
        y="0"
        width="${width}"
        height="${height}"
        rx="${radius}"
        ry="${radius}"
        fill="#ffffff"
      />
    </svg>
  `);

  return sharp(photoPath)
    .autoOrient()
    .resize(width, height, {
      fit: "cover",
      position: "centre",
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
  );

  const fullName = [
    input.firstName,
    input.middleName,
  ]
    .filter(Boolean)
    .join(" ");

  const layers: OverlayOptions[] = [
    {
      input: photoLayer,
      left: layout.photo.x,
      top: layout.photo.y,
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

    createTextOverlay(
      formatDate(input.validUntil),
      layout.fields.validUntil,
    ),
  ];

  if (await fileExists(stampOverlayPath)) {
    const stampMetadata = await sharp(
      stampOverlayPath,
    ).metadata();

    if (
      stampMetadata.width !== layout.canvas.width ||
      stampMetadata.height !== layout.canvas.height
    ) {
      throw new Error(
        [
          "Неверный размер stamp-overlay.png.",
          `Ожидается: ${layout.canvas.width}x${layout.canvas.height}.`,
          `Получено: ${stampMetadata.width}x${stampMetadata.height}.`,
        ].join(" "),
      );
    }

    layers.push({
      input: stampOverlayPath,
      left: 0,
      top: 0,
    });
  }

  await mkdir(
    path.dirname(input.outputPath),
    { recursive: true },
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