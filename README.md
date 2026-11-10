# AI Meeting Analyzer Pro · занятие 7

Локальное приложение принимает MP4 и WebM с компьютера или по публичной ссылке Google Drive. Оно автоматически извлекает аудио, сохраняет транскрипт и формирует четыре раздела конспекта: резюме, решения, задачи и открытые вопросы. Результаты и статусы остаются в локальной истории после обновления страницы.

Google Cloud, OAuth и API-ключ Google для публичного импорта не нужны. Допустимы обычные ссылки `https://drive.google.com/file/d/ID/view` и ссылки скачивания `https://drive.google.com/uc?export=download&id=ID`. Разрешите скачивание для всех, у кого есть ссылка, и сохраните параметр `resourcekey`, если он есть. Если Google возвращает страницу подтверждения или запрещает скачивание по ссылке, сохраните файл вручную и выберите его через загрузку в интерфейсе. Лимит — **50 000 000 байт**, длительность — до **5 минут** с допуском 0,25 с на контейнер. Нужны аудио- и видеодорожки.

## Локальный запуск

1. Установите Node.js 24, FFmpeg и FFprobe. Убедитесь, что `node` доступен в PATH. Укажите пути к установленным медиаинструментам. Если они уже в PATH, воспользуйтесь командами ниже. На Windows приложение также знает стандартные пути Shutter Encoder.
2. Откройте PowerShell в корне проекта и задайте ключ OpenAI в окружении текущего процесса. Используйте только учебные записи, на обработку которых есть разрешение. Приложение отправляет аудио в `gpt-transcribe` и транскрипт в `gpt-5.6-luna`; эти вызовы могут тарифицироваться.

```powershell
$env:POC_FFMPEG_PATH = (Get-Command ffmpeg -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$env:POC_FFPROBE_PATH = (Get-Command ffprobe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OpenAI API key' -AsSecureString)).Password
node --use-system-ca lite-app/server.mjs
```

Откройте `http://127.0.0.1:4317/`. Вставьте ссылку и нажмите «Импортировать» или выберите файл вручную. При импорте того же успешно обработанного файла приложение открывает сохранённую встречу по SHA-256 без повторного анализа. Если предыдущий AI-анализ завершился ошибкой, приложение не запускает платный запрос автоматически. Без ключа можно открыть интерфейс и читать существующую историю.

`--use-system-ca` позволяет Node.js доверять системным сертификатам Windows при необходимости. Проверка TLS остаётся включённой. История хранится в `lite-app/data/`, вне Git.

## Офлайн-проверка

Из корня проекта на Node.js 24 с доступными FFmpeg и FFprobe:

```powershell
node --test --test-isolation=none drive-poc/import.test.mjs drive-poc/public-download.test.mjs yandex-poc/import.test.mjs lite-app/app.test.mjs lite-app/frontend.test.mjs
```

Тесты используют синтетические медиа, временные каталоги и подставные ответы Google Drive и AI. Отдельный CLI `drive-poc/public-download.mjs` проверяет скачивание по публичной ссылке без OpenAI и удаляет временный файл.

## Состав проекта

- `lite-app/` — локальный сервер, общий анализатор, веб-интерфейс и тесты.
- `drive-poc/` — импорт по публичной ссылке и отдельный прежний API PoC.
- `yandex-poc/` — архивный PoC. Публичный импорт Google Drive переиспользует его защищённый HTTPS-транспорт.
- `poc/media.mjs` — работа с FFmpeg и FFprobe.
- `docs/ffmpeg-poc/` — локальные результаты проверки Linux-пакета. Выполнение бинарников на Vercel остаётся отдельной проверкой.
