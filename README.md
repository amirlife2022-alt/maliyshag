# Qawiyy — трекер привычек

Telegram Mini App: https://t.me/maliyshagbot

- `index.html` — приложение (GitHub Pages)
- `config.js` — адрес сервера, создаётся автоматически при выкладке
- `server/` — сервер на Cloudflare Workers + D1: бот, синхронизация, напоминания после асра
- `.github/workflows/deploy-server.yml` — автоматическая выкладка сервера при изменениях в `server/`

Секреты репозитория: `BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Команды бота для владельца: `/admin` (один раз, назначить себя), `/stats`.
