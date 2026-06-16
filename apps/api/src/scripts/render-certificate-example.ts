import path from "node:path";

import { renderCertificate } from "../modules/certificates";

async function main(): Promise<void> {
  /*
   * Этот скрипт нужно запускать из папки apps/api.
   * Поэтому корень репозитория находится на два уровня выше.
   */
  const repositoryRoot = path.resolve(
    process.cwd(),
    "../..",
  );

  const templateDirectory = path.join(
    repositoryRoot,
    "storage",
    "certificates",
    "templates",
    "volunteer-card-v1",
  );

  const photoPath = path.join(
    repositoryRoot,
    "storage",
    "certificates",
    "photos",
    "test-photo.jpg",
  );

  const outputPath = path.join(
    repositoryRoot,
    "storage",
    "certificates",
    "generated",
    "test-certificate.png",
  );

  const resultPath = await renderCertificate({
    templateDirectory,
    photoPath,
    outputPath,

    lastName: "Баштова",
    firstName: "Людмила",
    middleName: "Олександрівна",

    certificateNumber: "104",
    validUntil: "2027-12-31",
  });

  console.log(`Удостоверение создано: ${resultPath}`);
}

main().catch((error: unknown) => {
  console.error("Ошибка генерации удостоверения:");

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});