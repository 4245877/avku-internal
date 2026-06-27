export interface MultipartPart {
  name: string;
  fileName?: string;
  contentType?: string;
  content: Buffer;
}

export function getMultipartBoundary(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];

  if (!boundary) {
    throw new Error("Не указан boundary для multipart/form-data.");
  }

  return boundary.trim();
}

export function parseContentDisposition(value: string): {
  name: string;
  fileName?: string;
} {
  const name = /(?:^|;\s*)name="([^"]*)"/i.exec(value)?.[1];
  const fileName = /(?:^|;\s*)filename="([^"]*)"/i.exec(value)?.[1];

  if (!name) {
    throw new Error("Некорректная часть multipart/form-data.");
  }

  return {
    name,
    fileName: fileName || undefined,
  };
}

export function parseMultipartBody(
  body: Buffer,
  contentType: string,
): MultipartPart[] {
  const boundary = getMultipartBoundary(contentType);
  const delimiter = `--${boundary}`;
  const segments = body
    .toString("latin1")
    .split(delimiter)
    .slice(1, -1);

  return segments.map((segment) => {
    const normalizedSegment = segment.startsWith("\r\n")
      ? segment.slice(2)
      : segment;
    const headerEndIndex = normalizedSegment.indexOf("\r\n\r\n");

    if (headerEndIndex === -1) {
      throw new Error("Некорректное multipart/form-data тело.");
    }

    const rawHeaders = normalizedSegment.slice(0, headerEndIndex);
    let rawContent = normalizedSegment.slice(headerEndIndex + 4);

    if (rawContent.endsWith("\r\n")) {
      rawContent = rawContent.slice(0, -2);
    }

    const headers = new Map<string, string>();

    for (const line of rawHeaders.split("\r\n")) {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex === -1) {
        continue;
      }

      headers.set(
        line.slice(0, separatorIndex).trim().toLowerCase(),
        line.slice(separatorIndex + 1).trim(),
      );
    }

    const disposition = parseContentDisposition(
      headers.get("content-disposition") ?? "",
    );

    return {
      ...disposition,
      contentType: headers.get("content-type"),
      content: Buffer.from(
        rawContent,
        "latin1",
      ),
    };
  });
}
