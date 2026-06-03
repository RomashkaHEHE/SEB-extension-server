# Extension Release Upload Contract

Status: implemented on the server.

The extension repository is private, so the public site must not link directly
to GitHub release assets. Instead, a GitHub Actions workflow in the private
extension repository uploads the release ZIP to this server. The public button
`Расширение` downloads the latest uploaded ZIP from:

```http
GET https://urfuseb.ru/downloads/extension/latest.zip
```

## Upload Endpoint

```http
POST https://urfuseb.ru/v1/releases/extension
Authorization: Bearer <SERVER_RELEASE_UPLOAD_TOKEN>
Content-Type: multipart/form-data
```

Multipart fields:

- `archive`: required `.zip` file.
- `tagName`: release tag, for example `v1.2.3`.
- `version`: optional version without `v`.
- `releaseName`: optional release title.
- `commitSha`: optional commit SHA.
- `publishedAt`: optional release publish time.
- `fileName`: optional public download filename.

Response `201`:

```json
{
  "release": {
    "available": true,
    "downloadUrl": "https://urfuseb.ru/downloads/extension/latest.zip",
    "fileName": "seb-extension-v1.2.3.zip",
    "originalName": "seb-extension-v1.2.3.zip",
    "tagName": "v1.2.3",
    "version": "1.2.3",
    "releaseName": "SEB Helper Pro v1.2.3",
    "commitSha": "abc123",
    "size": 123456,
    "sha256": "64-char-hex",
    "publishedAt": "2026-06-04T00:00:00Z",
    "uploadedAt": "2026-06-04T00:01:00.000Z"
  }
}
```

The server stores only the latest uploaded archive.

## Metadata Endpoint

```http
GET https://urfuseb.ru/v1/extension-release/latest
```

If no ZIP was uploaded yet:

```json
{
  "release": {
    "available": false,
    "downloadUrl": null
  }
}
```

## Recommended GitHub Actions Workflow

This workflow should live in the private extension repository. Adjust the build
command and ZIP path to the extension repo structure.

```yaml
name: Upload extension release to server

on:
  release:
    types:
      - published

jobs:
  upload-extension-release:
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm

      - name: Build extension ZIP
        run: |
          set -euo pipefail
          npm ci
          npm run build

      - name: Find ZIP
        id: zip
        run: |
          set -euo pipefail
          ZIP_PATH="$(find dist build release -maxdepth 2 -type f -name '*.zip' 2>/dev/null | head -n 1)"
          if [ -z "$ZIP_PATH" ]; then
            echo "No extension ZIP was found" >&2
            exit 1
          fi
          echo "path=$ZIP_PATH" >> "$GITHUB_OUTPUT"

      - name: Upload ZIP to server
        env:
          SERVER_RELEASE_UPLOAD_URL: ${{ secrets.SERVER_RELEASE_UPLOAD_URL }}
          SERVER_RELEASE_UPLOAD_TOKEN: ${{ secrets.SERVER_RELEASE_UPLOAD_TOKEN }}
        run: |
          set -euo pipefail
          curl --fail-with-body -sS -X POST "$SERVER_RELEASE_UPLOAD_URL" \
            -H "Authorization: Bearer $SERVER_RELEASE_UPLOAD_TOKEN" \
            -F "archive=@${{ steps.zip.outputs.path }}" \
            -F "tagName=${{ github.event.release.tag_name }}" \
            -F "version=${{ github.event.release.tag_name }}" \
            -F "releaseName=${{ github.event.release.name }}" \
            -F "commitSha=${{ github.sha }}" \
            -F "publishedAt=${{ github.event.release.published_at }}" \
            -F "fileName=seb-extension-${{ github.event.release.tag_name }}.zip"
```

## Required Extension Repository Secrets

- `SERVER_RELEASE_UPLOAD_URL`: `https://urfuseb.ru/v1/releases/extension`
- `SERVER_RELEASE_UPLOAD_TOKEN`: the same token configured on the server as
  `EXTENSION_RELEASE_UPLOAD_TOKEN`.

## Server Repository Secret

The server repository deploy workflow must also have:

- `EXTENSION_RELEASE_UPLOAD_TOKEN`: the token accepted by the upload endpoint.

This prevents future server deploys from overwriting `.env` with an empty upload
token.
