import { DatabaseSync } from "node:sqlite";

const databasePath = process.env.CERTIFICATES_DATABASE_PATH;
const checkOnly = process.argv.includes("--check");

if (!databasePath) {
  throw new Error("Set CERTIFICATES_DATABASE_PATH to certificates.sqlite.");
}

// Values are transcribed from /home/hpelitdesk/англ ФОТО. Ukrainian owner
// names are an additional guard: a number match alone is never enough to write.
const englishNames = [
  ["012", "Калінін Вячеслав Володимирович", "Viacheslav", "Kalinin"],
  ["013", "Капітоненко Олексій Олександрович", "Oleksii", "Kapitonenko"],
  ["36", "Козлов Сергій Леонідович", "Serhiy", "Kozlov"],
  ["40", "Коренюк Микола Олександрович", "Mykola", "Koreniuk"],
  ["41", "Лук’янець Вадим Михайлович", "Vadim", "Lukyanets"],
  ["055", "Бодюк Богдан Володимирович", "BOHDAN", "BODIUK"],
  ["056", "Кравцов Ігор Володимирович", "Ihor", "Kravtsov"],
  ["058", "Заєць Микола Віталійович", "Mykola", "Zaiets"],
  ["059", "Заєць Наталія Анатоліївна", "Natalia", "Zaiets"],
  ["060", "Гордієнко Марина", "Maryna", "Hordiienko"],
  ["061", "Корзун Олег Олександрович", "Oleh", "Korzun"],
  ["062", "Корзун Олександр Олегович", "Oleksandr", "Korzun"],
  ["063", "Степаненко Альона Валеріївна", "Alona", "Stepanenko"],
  ["064", "Кожан Інна Михайлівна", "Inna", "Kozhan"],
  ["065", "Захарова Наталія Олександрівна", "Nataliia", "Zakharova"],
  ["077", "Фека Карина Робертівна", "Karina", "FEKA"],
  ["079", "Іванюк Костянтин Михайлович", "Kostyantyn", "Ivanyuk"],
  ["082", "Семенюк Світлана Іванівна", "Svitlana", "Semenyuk"],
  ["084", "Коба Варвара Євмініївна", "Varvara", "KOBA"],
  ["085", "Мілієнко Олександр Миколайович", "Oleksandr", "Milienko"],
  ["087", "Мельник Надія Михайлівна", "Nadia", "Melnyk"],
  ["088", "Дмитрієва Ніна Володимирівна", "Nina", "Dmitrieva"],
  ["089", "Малиновська Марія Іванівна", "Maria", "Malinovska"],
  ["091", "Дмитрієва Тетяна Федосіївна", "Tatyana", "Dmitrieva"],
  ["092", "Шмирко Валентина Миколаївна", "Valentine", "Shmyrko"],
  ["093", "Чудіна Ріта Яківна", "Rita", "Chudina"],
  ["095", "Астапенко Валентина Федорівна", "Valentina", "Astapenko"],
  ["096", "Владимирець Світлана Вадимівна", "Svitlana", "Vladimirets"],
  ["100", "Іщук Тетяна Володимирівна", "Tetiana", "Ishchuk"],
  ["101", "Матвійчук Тетяна Володимирівна", "Tetiana", "Matviichuk"],
  ["102", "Личак Валерій Володимирович", "Valerii", "Lychak"],
  ["103", "Махмудов Абдурахім Хасанович", "Abdurakhim", "Makhmudov"],
  ["104", "Баштова Людмила Олександрівна", "Liudmyla", "Bashtova"],
  ["107", "Комаренко Наталія Володимирівна", "Nataliia", "Komarenko"],
  ["108", "Юрчак Євгенія Григорівна", "Evgenia", "YURCHAK"],
  ["110", "Говоруха Світлана", "Svitlana", "Hovorukha"],
  ["111", "Зарванський Іван Миколайович", "Ivan", "Zarvanskyi"],
  ["113", "Горбатюк Яна Геннадіївна", "Yana", "Horbatiuk"],
  ["116", "Сатко Владислав Олегович", "Vladyslav", "Satko"],
  ["117", "Потійчук Ірина Іванівна", "Iryna", "Potiichuk"],
  ["118", "Максимчук Ірина Ігорівна", "Iryna", "Maksymchuk"],
  ["119", "Скиба Марина Юріївна", "Maryna", "Skyba"],
  ["120", "Яременко Лариса Анатоліївна", "Larysa", "Yaremenko"],
  ["121", "Сидоренко Лілія", "Liliia", "Sydorenko"],
  ["122", "Каліберда Михайло Олександрович", "Mykhailo", "Kaliberda"],
  ["123", "Радченко Марія Андріївна", "Mariia", "Radchenko"],
  ["128", "Аглоткова Світлана", "Svitlana", "Aglotkova"],
  ["129", "Аглотков Вячеслав", "Viacheslav", "Aglotkov"],
  ["133", "Зелена Зінаїда Володимирівна", "Zinaida", "Zelena"],
  ["134", "Павленко Вікторія Ігорівна", "Viktoriia", "Pavlenko"],
  ["135", "Притолюк Мар’яна Миколаївна", "Mariana", "Prytoliuk"],
  ["136", "Павленко Антон Павлович", "Anton", "Pavlenko"],
  ["137", "Притолюк Жанна Пилипівна", "Zhanna", "Prytoliuk"],
  ["138", "Міняйло Олександр Олександрович", "Oleksandr", "Miniailo"],
  ["139", "Міняйло Євгенія Валеріївна", "Yevheniia", "Miniailo"],
  ["140", "Наталенко Олександра Сергіївна", "Oleksandra", "Natalenko"],
  ["141", "Наталенко Андрій Михайлович", "Andrii", "Natalenko"],
  ["142", "Кобильчук Микита Андрійович", "MYKUTA", "KOBYLCHUK"],
  ["143", "Городецька Маргарита Юріївна", "Marharyta", "Horodetska"],
  ["144", "Осіпова Олеся Сергіївна", "Olesia", "Osipova"],
  ["145", "Дедела Анастасія Володимирівна", "Anastasiia", "Dedela"],
  ["146", "Шовковська Валентина Володимирівна", "Valentyna", "Shovkovska"],
  ["147", "Галай Валентина Ігорівна", "Valentyna", "Halai"],
  ["148", "Карпенко Ольга Миколаївна", "Olha", "Karpenko"],
  ["149", "Карпенко Сергій Іванович", "Serhii", "Karpenko"],
  ["150", "Примушко Сергій Григорович", "Serhii", "Prymushko"],
  ["151", "Скорнякова Олена Олегівна", "Olena", "Skorniakova"],
  ["152", "Чупрова Людмила Сергіївна", "Lyudmyla", "Chuprova"],
  ["153", "Соболєва Ірина Володимирівна", "Iryna", "Sobolieva"],
  ["154", "Соболєва Тетяна Вікторівна", "Tetiana", "Sobolieva"],
  ["155", "Горчак Ірина Варсанофіївна", "Iryna", "Horchak"],
  ["156", "Носкіна Лідія Кирилівна", "Lidiia", "Noskina"],
  ["157", "Коваленко Надія Миколаївна", "Nadiia", "Kovalenko"],
  ["158", "Кубенко Віра Павлівна", "Vira", "Kubenko"],
  ["159", "Пінязь Вікторія Вікторівна", "Viktoriia", "Piniaz"],
  ["160", "Петречко Богдан Іванович", "Bohdan", "Petrechko"],
  ["161", "Плетньова Любов Валеріївна", "Liubov", "Pletniov"],
  ["162", "Ласька Людмила Альбертівна", "Liudmyla", "Laska"],
  ["163", "Гоменюк Жанна Леонідівна", "Zhanna", "Homeniuk"],
  ["164", "Гордієва Тетяна Миколаївна", "Tetiana", "Hordiieva"],
  ["166", "Цуканов Іван Миколайович", "Ivan", "Tsukanov"],
  ["167", "Салабай Олександр Миколайович", "Oleksandr", "Salabai"],
  ["168", "Чекиш Назар Вікторович", "Nazar", "Chekysh"],
  ["169", "Буднік Ірина Олександрівна", "Iryna", "Budnik"],
  ["170", "Плетньов Руслан Олександрович", "Ruslan", "Pletnov"],
];

const database = new DatabaseSync(databasePath);
const columns = new Set(
  database.prepare("PRAGMA table_info(certificate_records)").all()
    .map((column) => String(column.name)),
);

for (const column of ["first_name_en", "last_name_en"]) {
  if (!columns.has(column)) {
    throw new Error(`Database migration is missing column ${column}.`);
  }
}

const numberSet = new Set(englishNames.map(([number]) => number));

if (numberSet.size !== englishNames.length) {
  throw new Error("English-name manifest contains duplicate certificate numbers.");
}

const rows = database.prepare(`
  SELECT id, certificate_number, full_name, first_name_en, last_name_en
  FROM certificate_records
  ORDER BY certificate_number
`).all();
const rowsByNumber = new Map(rows.map((row) => [row.certificate_number, row]));
const errors = [];

for (const [number, expectedOwner] of englishNames) {
  const row = rowsByNumber.get(number);

  if (!row) {
    errors.push(`No database row for certificate ${number}.`);
  } else if (row.full_name !== expectedOwner) {
    errors.push(
      `Owner mismatch for ${number}: expected "${expectedOwner}", got "${row.full_name}".`,
    );
  }
}

const unlistedRows = rows
  .filter((row) => !numberSet.has(row.certificate_number))
  .map((row) => `${row.certificate_number} ${row.full_name}`);

if (unlistedRows.length > 0) {
  errors.push(`Database rows missing from manifest: ${unlistedRows.join(", ")}.`);
}

if (errors.length > 0) {
  throw new Error(errors.join("\n"));
}

let changed = 0;

if (!checkOnly) {
  const update = database.prepare(`
    UPDATE certificate_records
    SET first_name_en = ?, last_name_en = ?
    WHERE id = ?
  `);

  database.exec("BEGIN IMMEDIATE");

  try {
    for (const [number, , firstNameEn, lastNameEn] of englishNames) {
      const row = rowsByNumber.get(number);

      if (
        row.first_name_en !== firstNameEn ||
        row.last_name_en !== lastNameEn
      ) {
        changed += Number(update.run(firstNameEn, lastNameEn, row.id).changes);
      }
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const duplicateNumbers = database.prepare(`
  SELECT certificate_number, COUNT(*) AS total
  FROM certificate_records
  GROUP BY certificate_number
  HAVING COUNT(*) > 1
`).all();
const populated = database.prepare(`
  SELECT COUNT(*) AS total
  FROM certificate_records
  WHERE length(trim(first_name_en)) > 0
    AND length(trim(last_name_en)) > 0
`).get();

console.log(JSON.stringify({
  mode: checkOnly ? "check" : "update",
  databaseRows: rows.length,
  manifestRows: englishNames.length,
  changed,
  englishNamesPopulated: Number(populated.total),
  duplicateNumbers,
}, null, 2));
