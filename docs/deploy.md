# Развёртывание «Ноготочек» на боевом сервере

Инструкция для Ubuntu/Debian. Сервис один: Node.js обслуживает и API, и
веб-фронтенд, поэтому нужен ровно один процесс и один домен.

Сборка не нужна: фронтенд — обычные HTML/CSS/JS, сервер отдаёт их из `web/`.

---

## Что понадобится

| Что | Зачем | Обязательно |
|-----|-------|-------------|
| VPS с Ubuntu 22.04+ или Debian 12+ | сам сервер | да |
| Домен или поддомен, например `nogotki.ru` | публичный адрес и HTTPS | да |
| Node.js 22.13+ (лучше 24 LTS) | рантайм: проект использует встроенный `node:sqlite` | да |
| nginx | TLS, редирект, проксирование | да |
| certbot | бесплатный сертификат Let's Encrypt | да |

Дешёвые VPS, которых достаточно для такого проекта: Hetzner CX22, Timeweb,
Selectel — от 200–400 ₽ в месяц. Один ядро, 1 ГБ RAM, 10 ГБ диска хватает
с запасом.

> **Почему не Vercel/Netlify/GitHub Pages.** Там нет долгоживущего процесса
> и постоянного диска, а проекту нужны оба: `node:sqlite` работает с файлом
> базы на диске, который у serverless-платформ стирается между запусками.

---

## 1. Подготовка сервера

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx certbot python3-certbot-nginx curl ufw
```

Node.js 24 LTS из репозитория NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # должно быть v22.13 или новее
```

Пользователь приложения — отдельный, без прав root и без входа по SSH:

```bash
sudo useradd --system --home /opt/nogotki --shell /usr/sbin/nologin nogotki
```

## 2. Код

```bash
sudo -u nogotki git clone https://github.com/ekaterinayava96-blip/nogotki-service.git /opt/nogotki
cd /opt/nogotki/backend
sudo -u nogotki npm ci --omit=dev
```

## 3. Настройки (здесь задаются пароли)

```bash
sudo install -d -m 750 -o root -g nogotki /etc/nogotki
sudo cp deploy/nogotki.env.example /etc/nogotki/nogotki.env
sudo chown root:nogotki /etc/nogotki/nogotki.env
sudo chmod 640 /etc/nogotki/nogotki.env
```

Сгенерируйте три **разных** пароля и впишите их в `SEED_ADMIN_PASSWORD`,
`SEED_MASTER_PASSWORD`, `SEED_CLIENT_PASSWORD`:

```bash
openssl rand -base64 18
openssl rand -base64 18
openssl rand -base64 18
sudo nano /etc/nogotki/nogotki.env
```

> **Это главный шаг безопасности.** Дев-пароли (`admin12345`, `master12345`,
> `client12345`) опубликованы в README. При `NODE_ENV=production` сид требует
> эти переменные и без них падает — специально, чтобы слабые учётки не
> появились на публичном сайте. Убедитесь, что пароль владельца нигде не
> совпадает с остальными.

## 4. База данных

```bash
cd /opt/nogotki/backend
sudo -u nogotki npm run db:migrate
sudo -u nogotki npm run db:seed
```

Миграции применяются и при старте сервера, но запустить их отдельно удобно:
так ошибки видны сразу, до того как nginx начнёт принимать клиентов.

Сид создаст услуги, мастеров, расписание и три учётки (admin/master/client).
Адрес и телефон студии будут демо-версии — их меняют в панели владельца
(раздел 8).

## 5. Сервис

```bash
sudo cp deploy/nogotki.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nogotki
sudo systemctl status nogotki
```

Проверка, что процесс жив и отвечает:

```bash
curl -s http://127.0.0.1:3000/health     # {"status":"ok"}
```

Если сервис не стартует — смотрите журнал:

```bash
sudo journalctl -u nogotki -n 50 --no-pager
```

Типичные причины: забыт `DB_PATH` в `.env` при `NODE_ENV=production`
(сообщение от `src/config.js`), либо папка `backend/data` не открыта на
запись для пользователя `nogotki`.

## 6. Брандмауэр

Открываем наружу только 80 и 443. Порт 3000 наружу не нужен — его слушает
только localhost, снаружи к нему обращается nginx.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 7. nginx и HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/nogotki
sudo sed -i 's/example.com/YOUR-DOMAIN.ru/g' /etc/nginx/sites-available/nogotki
sudo ln -s /etc/nginx/sites-available/nogotki /etc/nginx/sites-enabled/nogotki
sudo rm -f /etc/nginx/sites-enabled/default      # иначе будет отдавать свою страницу
sudo nginx -t && sudo systemctl reload nginx
```

Сертификат (DNS уже должен указывать на IP сервера):

```bash
sudo certbot --nginx -d YOUR-DOMAIN.ru
```

Certbot сам допишет в конфиг блок с редиректом на HTTPS и задаст автопродление.
Проверить: `sudo certbot renew --dry-run`.

## 8. После первого входа

Войдите как `admin` на `https://YOUR-DOMAIN.ru/login.html` и проверьте:

1. **«Панель владельца» → вкладка «Правила»** — адрес, телефон, Telegram студии.
   В сиде стоит демо-версия (Воронеж, тестовые телефоны): замените своими,
   они показываются клиенту на лендинге, в подтверждении записи и в окне отмены.
2. **«Услуги»** — уберите лишние демо-услуги, поставьте свои цены и длительности.
3. **«Мастера»** — уберите демо-мастеров, заведите своих, каждому — услуги и график.
4. **«График»** — проверьте рабочие дни и часы.

### Убрать демо-записи

Сид создаёт трёх демо-клиентов и три записи для них. Записи удаляются по
телефонам демо-клиентов — на момент сида это `+79000000001` (Анна Петрова)
и `+79000000002` (Ирина Соколова):

```bash
cd /opt/nogotki/backend
sudo -u nogotki node -e '
  const db = require("./src/db/connection");
  const phones = ["+79000000001", "+79000000002"];
  const ph = phones.map(() => "?").join(",");
  // Сначала посмотреть, что будет удалено:
  const rows = db.prepare(
    `SELECT b.id, b.starts_at, c.name, c.phone FROM bookings b
     JOIN clients c ON c.id = b.client_id WHERE c.phone IN (${ph})`
  ).all(...phones);
  rows.forEach((r) => console.log("  удалим запись", r.id, r.starts_at, r.name, r.phone));
  const n = db.prepare(`DELETE FROM bookings WHERE client_id IN (SELECT id FROM clients WHERE phone IN (${ph}))`).run(...phones).changes;
  const c = db.prepare(`DELETE FROM clients WHERE phone IN (${ph})`).run(...phones).changes;
  console.log("удалено записей:", n, "| клиентов:", c);
  db.close();
'
```

Связанные строки (услуги записи, отзывы) удаляются каскадом — проверьте
после выполнения, что всё чисто:

```bash
sudo -u nogotki node -e '
  const db = require("./src/db/connection");
  const n = db.prepare(
    "SELECT COUNT(*) AS c FROM booking_services WHERE booking_id NOT IN (SELECT id FROM bookings)"
  ).get().c;
  console.log(n === 0 ? "битых связей нет" : "битых связей: " + n);
  db.close();
'
```

> Удалять записи нужно **до** первого прихода настоящих клиентов. Услуги и
> мастера из сида удаляются через панель владельца, а не SQL: каскад там не
> настроен, и проще сделать это мышкой.

## 9. Проверка, что всё работает

| Что | Как проверить |
|-----|---------------|
| Сайт открыт | `https://YOUR-DOMAIN.ru/` отдаёт лендинг |
| Каталог | на главной видны услуги с ценами |
| Запись с телефона | пройти флоу до подтверждения, запись видна в «Мои записи» |
| Вход клиента | зарегистрироваться, войти, кабинет открывается |
| Кабинет владельца | `admin` видит записи, смену статуса, услуги, график |
| HTTPS | замок в адресной строке, `http://` перекидывает на `https://` |
| Мобильная вёрстка | открыть на телефоне: меню сворачивается под ☰, слоты в две колонки |

## 10. Бэкапы

Проект умеет снимать копию базы сам, старые копии (14 суток) удаляет:

```bash
cd /opt/nogotki/backend && sudo -u nogotki npm run db:backup
```

По расписанию — раз в сутки, файл `/etc/cron.d/nogotki-backup`:

```
30 3 * * * cd /opt/nogotki/backend && sudo -u nogotki /usr/bin/node src/db/backup.js
```

```bash
sudo chmod 644 /etc/cron.d/nogotki-backup
```

Копии лежат в `backend/data/backups/`. **Их нужно забирать с сервера** — копия
на том же диске не спасёт, если диск выйдет из строя. Для этого подойдёт
любой из способов: rsync по SSH на свою машину, копия в S3-совместимое
хранилище, либо автоматические снапшоты диска у хостера.

## 11. Обновление после выхода новой версии

```bash
cd /opt/nogotki
sudo -u nogotki git pull
cd backend
sudo -u nogotki npm ci --omit=dev
sudo systemctl restart nogotki
curl -s http://127.0.0.1:3000/health
```

Миграции применятся при старте. Перед обновлением снесите бэкап (раздел 10).

Откат, если новая версия не пошла:

```bash
cd /opt/nogotki && sudo -u nogotki git checkout <коммит-до-обновления>
sudo systemctl restart nogotki
```

---

## Шпаргалка: адреса и файлы

| Что | Где |
|-----|-----|
| Код | `/opt/nogotki` |
| Настройки (секреты) | `/etc/nogotki/nogotki.env` |
| Юнит systemd | `/etc/systemd/system/nogotki.service` |
| Конфиг nginx | `/etc/nginx/sites-available/nogotki` |
| Файл базы | `/opt/nogotki/backend/data/nogotki.db` |
| Бэкапы базы | `/opt/nogotki/backend/data/backups/` |
| Журнал сервиса | `journalctl -u nogotki` |
| Журнал nginx | `/var/log/nginx/nogotki.*.log` |
