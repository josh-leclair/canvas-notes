# Reviewer notes for 1.0.1

Canvas Notes Web Clipper is a client for a self-hosted note-taking application.
All network requests are direct user-initiated captures to the server configured
on the options page. There is no remote code, telemetry, passive page access, or
private-browsing operation.

## Test account

- Server URL: `REPLACE_WITH_TEMPORARY_HTTPS_TEST_SERVER`
- API token: `REPLACE_WITH_REVOCABLE_CNV_TOKEN`

The token can access only the supplied test user's Canvas Notes account and will
remain active for the review period.

## Functional test

1. Install the extension. Firefox shows the required data categories and then
   the extension opens its setup page.
2. Enter the test server URL and token. Select **Save and test connection**.
3. Open a normal HTTPS article. Select the toolbar icon and test **Clip page**,
   **Clip selection**, and **Clip simplified article**.
4. Right-click selected text, a link, and an image to test the corresponding
   **Canvas Notes** commands.
5. Open a YouTube watch URL and select **Clip video**. The server returns a
   YouTube card through its existing `/api/capture` URL classifier.
6. Open the supplied Canvas Notes inbox; all created cards appear unplaced.

## Network behavior

- `GET {configured server}/api/me` occurs only when saving/testing setup.
- `POST {configured server}/api/capture` occurs only after a clip command.
- `POST {configured server}/api/capture/file` occurs only for **Clip image**.
- An image GET goes to the explicitly chosen image URL before upload. The
  extension requests that exact image origin at that time and omits credentials.

The API token is sent as `Authorization: Bearer …` only to the configured Canvas
Notes server. Redirects are rejected for authenticated API requests.

## Build/source

No build transformation is used. `npm run build` invokes `web-ext build`, which
copies the reviewable source files into a ZIP. `web-ext-config.mjs` lists files
excluded from the runtime package. Node.js 20+ and the official npm registry are
the only requirements.
