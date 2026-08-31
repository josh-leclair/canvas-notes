# Mozilla submission checklist

## Prepared files

- Upload package: `artifacts/canvas_notes_web_clipper-1.0.1.zip`
- Source: this `extension/` directory, or a ZIP of it excluding `node_modules/`
  and `artifacts/`
- Listing copy: `docs/listing.md`
- Reviewer notes: `docs/reviewer-notes.md`
- Privacy policy: `privacy.html` and `docs/privacy-policy.md`

## Before uploading

1. Add a support email or project URL to the AMO listing.
2. Provide reviewers with a temporary HTTPS Canvas Notes test deployment and a
   revocable `cnv_…` API token. Replace the placeholders in reviewer notes.
3. Run `npm ci`, `npm test`, `npm run lint`, and `npm run build`.
4. Confirm version `1.0.1` has not already been uploaded for the fixed add-on ID
   `{a65bfc59-e31c-4b51-83e9-3a8de0311050}`.

## Listed release on addons.mozilla.org

Upload the artifact through the AMO Developer Hub and choose **On this site**.
Paste the listing and reviewer notes, disclose the same three required data
categories declared in the manifest, and attach source if requested.

For CLI submission, create AMO API credentials and use the current `web-ext`
submission flow. Never commit the issuer or secret.

## Signed private installation

For an installable XPI without a public AMO listing:

```sh
npx web-ext sign --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

Mozilla still reviews/signs unlisted builds. The returned `.xpi` can be opened
in standard Firefox. An unsigned ZIP can only be loaded temporarily through
`about:debugging` or installed in special development builds.
