# План переноса DNS-зоны avku.org в Cloudflare

Цель: включить Cloudflare Access + Tunnel для `internal.avku.org`,
НЕ сломав статический сайт avku.org / www.avku.org (GitHub Pages)
и почту через mail.imena.com.ua.

Регистратор остаётся imena.com.ua. Переносится только управление DNS
(nameservers). Владение доменом не меняется, ничего не покупается.

Статус: ПЛАН. Выполняется вручную в панелях Cloudflare и imena.com.ua
по отдельному подтверждению. Сервера не касается вообще.

---

## Зафиксированное текущее состояние (baseline, снято 2026-07-09)

Nameservers: `pid1.srv53.net`, `pid2.srv53.org` (imena.com.ua)

| Имя | Тип | Значение | Примечание |
|---|---|---|---|
| @ (avku.org) | A | 185.199.108.153 | GitHub Pages |
| @ | A | 185.199.109.153 | GitHub Pages |
| @ | A | 185.199.110.153 | GitHub Pages |
| @ | A | 185.199.111.153 | GitHub Pages |
| www | CNAME | 4245877.github.io | GitHub Pages |
| @ | MX 10 | mail.imena.com.ua | почта |

TXT-записей нет (проверено dig: ни SPF, ни _github-pages-challenge).
AAAA-записей нет. Поддомена internal нет.

## Шаг 1. Добавить зону в Cloudflare (без смены NS — ещё ничего не ломается)

1. dash.cloudflare.com → Add a domain → `avku.org` → план Free.
2. Cloudflare отсканирует зону сам, но проверить вручную, что импортированы
   ВСЕ 6 записей из таблицы выше. Чего не хватает — добавить руками.
3. Режим проксирования (облачко) для каждой записи:

   | Запись | Proxy | Почему |
   |---|---|---|
   | A @ ×4 | **DNS only (серое)** | GitHub Pages сам выдаёт TLS-сертификат; серое облачко = поведение байт-в-байт как сейчас |
   | CNAME www | **DNS only (серое)** | то же |
   | MX @ | DNS only | MX не проксируется в принципе |

   Оранжевое облачко для GitHub Pages включать не нужно (можно потом,
   осознанно; для задачи internal.avku.org оно не требуется).
4. Запись для `internal` НЕ создавать вручную — её создаст туннель (шаг 3).

Пока NS не сменены, Cloudflare-зона неактивна и ни на что не влияет.
Это безопасная точка: можно проверить список записей сколько угодно раз.

## Шаг 2. Сменить nameservers у регистратора

1. Cloudflare после добавления зоны покажет ДВА персональных nameserver'а
   вида `xxx.ns.cloudflare.com` / `yyy.ns.cloudflare.com` (точные имена
   видны на странице зоны, раздел Nameservers).
2. В панели imena.com.ua для avku.org: заменить
   `pid1.srv53.net` / `pid2.srv53.org` на выданные Cloudflare.
3. Старую зону в панели imena НЕ удалять — это план отката.
4. Распространение: минуты…24 часа. Простоя нет: обе зоны в этот период
   отдают одинаковые записи.
5. Дождаться в Cloudflare статуса зоны Active (придёт письмо).

## Шаг 3. Туннель и Access — только для internal.avku.org

По docs/cloudflare-access-setup.md, с конкретными значениями:

- Public hostname туннеля: `internal` . `avku.org` → Service `HTTP`
  `nginx:80`. Cloudflare сам создаст проксированную CNAME-запись
  `internal` → `<tunnel-id>.cfargotunnel.com`. Руками DNS не трогать.
- Access Application: домен приложения `internal.avku.org`, path пустой —
  накрывает и frontend, и /api. Политика Allow → Emails →
  `alner4245877@gmail.com`.
- Корень avku.org и www в Access НЕ добавлять — они остаются публичным
  статическим сайтом, как сейчас.

## Откат

- Шаг 2 обратим: вернуть в панели imena старые NS
  `pid1.srv53.net` / `pid2.srv53.org` (зона там сохранена) — всё
  возвращается к сегодняшнему состоянию за время TTL.
- Туннель/Access удаляются в Zero Trust независимо, сайт avku.org
  они не затрагивают в любом случае.

## Проверки

### До смены NS (baseline — уже снят, повторить непосредственно перед сменой)

```bash
dig +short NS avku.org
dig +short A avku.org
dig +short CNAME www.avku.org
dig +short MX avku.org
curl -sI https://avku.org/  | head -5    # ожидаем HTTP/2 200 (или 301 на www)
curl -sI https://www.avku.org/ | head -5
```

### После смены NS (через несколько часов)

```bash
# NS сменились:
dig +short NS avku.org                    # -> *.ns.cloudflare.com

# записи отдаются те же самые:
dig +short A avku.org @1.1.1.1            # -> те же 185.199.108-111.153
dig +short CNAME www.avku.org @1.1.1.1    # -> 4245877.github.io
dig +short MX avku.org @1.1.1.1           # -> 10 mail.imena.com.ua

# статический сайт жив, сертификат в порядке:
curl -sI https://avku.org/ | head -5
curl -sI https://www.avku.org/ | head -5
curl -svo /dev/null https://avku.org 2>&1 | grep -E "issuer|subject:"
# ожидаем issuer Let's Encrypt (сертификат GitHub Pages), код 200/301 как до

# почта: MX резолвится, mail-сервер imena отвечает (не обязательно):
dig +short A mail.imena.com.ua
```

Плюс вручную: открыть avku.org и www.avku.org в браузере,
отправить/получить тестовое письмо на ящик @avku.org.

### internal.avku.org закрыт Access (после шага 3 и запуска cloudflared)

```bash
bash scripts/verify-access.sh internal.avku.org
```

Ожидаем: `/`, `/api/health`, `/api/warehouse` → 302 на
`<team>.cloudflareaccess.com` (или 403), JSON без входа не отдаётся,
локальный 192.168.0.151:18080 работает, 18080 привязан к LAN-IP.

### SKUFnya не затронут

DNS-перенос вообще не касается сервера, но контрольно до и после:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep skufnya
```

Ожидаем: 6/6 Up, skufnya-nginx владеет 80/443/8080. Домен магазина —
другая зона, его DNS и nameservers не меняются.

## Риски и примечания

- Пока облачка серые (DNS only), Cloudflare для avku.org/www — чистый DNS:
  трафик GitHub Pages через Cloudflare не проходит, сертификаты живут
  как раньше. Минимум изменений = минимум рисков.
- У зоны нет SPF/DMARC (не было и раньше). На доставляемость почты перенос
  не влияет, но SPF стоит завести отдельно — независимо от этой задачи.
- Если у регистратора включён DNSSEC — перед сменой NS его надо выключить
  (или перенастроить в Cloudflare), иначе резолвинг сломается. Судя по
  зоне imena, DNSSEC не активен, но проверить в панели перед сменой.
