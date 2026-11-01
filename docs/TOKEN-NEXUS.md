# Token Nexus integration

DriveFromMusic can use Token Nexus as its server-side source of Google Drive access tokens.

## Server configuration

Set these variables only in the DriveFromMusic server environment:

- `TOKEN_NEXUS_URL=https://token-nexus-api.mylahari.workers.dev`
- `TOKEN_NEXUS_CLIENT_KEY=<the DriveFromMusic-specific app key>`

Set the matching Worker secret in Token Nexus as `DRIVE_FROM_MUSIC_CLIENT_KEY`. Never commit or expose the key in browser code.

Connect the **DriveFromMusic** Google integration in the Token Nexus dashboard first. The app calls `GET /api/client/drive-from-music/access-token` from its server with an Authorization bearer header. Token Nexus owns the refresh token and refresh lifecycle; DriveFromMusic receives only a short-lived access token.

If Token Nexus is configured but unavailable or requires reconnection, DriveFromMusic fails the Drive operation rather than falling back to an old local token. If the Token Nexus variables are absent, the existing local OAuth flow remains available for development.
