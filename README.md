# SEB Extension Server

Remote session server for SEB Helper Pro.

## API

Implemented contract:

- `POST /v1/extension/sessions`
- `PATCH /v1/extension/sessions/:sessionId/heartbeat`
- `POST /v1/extension/sessions/:sessionId/screenshots`
- `POST /v1/extension/sessions/:sessionId/moodle/questions`
- `PATCH /v1/extension/sessions/:sessionId/close`
- `GET /v1/operator/sessions`
- `GET /v1/operator/sessions/:sessionId`
- `GET /v1/operator/sessions/:sessionId/screenshots/latest`
- `POST /v1/operator/sessions/:sessionId/messages`
- `GET /v1/operator/sessions/:sessionId/moodle/questions`
- `GET /v1/operator/sessions/:sessionId/moodle/questions/:questionId`
- `POST /v1/operator/sessions/:sessionId/moodle/questions/:questionId/answers`
- `POST /v1/operator/sessions/:sessionId/commands`
- `WS /v1/extension/ws?sessionId=...`
- `WS /v1/operator/ws`

The operator dashboard is served at `/`.
Operator dashboard, REST API, and WebSocket are public and do not require auth.
Session list responses include a short `displayId` (`0001`, `0002`, ...), and
the default operator session list only returns active sessions.
Operators cannot claim sessions and cannot open or close the extension chat.
Operator messages can include `operatorDisplayName`; the extension receives the
same value in `operator.message`.

Moodle question transfer is described in `MOODLE_QUESTION_CONTRACT.md`.

## Local Run

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`.

## Environment

- `PORT`: HTTP port, default `3000`.
- `HOST`: listen host, default `0.0.0.0`.
- `PUBLIC_BASE_URL`: public site URL used in API responses, for example `https://urfuseb.ru`.
- `DATA_DIR`: disk storage for sessions and screenshots, default `./data`.
- `SCREENSHOT_MAX_BYTES`: multipart screenshot limit, default `8388608`.
- `CORS_ORIGIN`: optional comma-separated allow-list.

## GitHub Actions Autodeploy

The repository has `.github/workflows/deploy.yml`. It runs tests on every push to
`main`, uploads a release archive to the server over SSH, writes `.env`, installs
production dependencies, and restarts the `seb-extension-server` user systemd
service.

The production service listens on `127.0.0.1:3010` behind nginx.

Required repository secrets:

- `DEPLOY_HOST`: server IP or host.
- `DEPLOY_USER`: SSH user.
- `DEPLOY_SSH_PORT`: SSH port, usually `22`.
- `DEPLOY_PATH`: target path, for example `/home/user1/apps/seb-extension-server`.
- `DEPLOY_SSH_PRIVATE_KEY`: private SSH key allowed in the server user's `authorized_keys`.
- `APP_PUBLIC_BASE_URL`: public URL, for example `https://urfuseb.ru`.
