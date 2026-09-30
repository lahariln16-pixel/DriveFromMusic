const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { google } = require("googleapis");

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ============================================================
// CONFIG
// ============================================================

const LOCAL_CREDENTIALS_FILE = path.join(
    __dirname,
    "credentials",
    "google-credentials.json"
);

const LOCAL_TOKEN_FILE = path.join(
    __dirname,
    "token.json"
);

const DRIVE_FOLDER_NAME =
    process.env.GOOGLE_DRIVE_FOLDER_NAME || "DriveFromMusic";

const GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/drive.file"
];

// Password used by the website.
//
// IMPORTANT:
// Set this on Render as:
// APP_PASSWORD=your-password
//
// For local testing you can run:
// APP_PASSWORD="your-password" npm start
//
const APP_PASSWORD =
    process.env.APP_PASSWORD || "changeme";

// ============================================================
// AUTH SESSION CONFIG
// ============================================================

const SESSION_COOKIE = "dfm_session";

const sessions = new Map();

const SESSION_DURATION =
    1000 * 60 * 60 * 24 * 7; // 7 days

// ============================================================
// EXPRESS
// ============================================================

app.use(express.json({ limit: "1mb" }));

// ============================================================
// LOGGING
// ============================================================

function log(message) {
    console.log(`[DriveFromMusic] ${message}`);
}

// ============================================================
// HELPERS
// ============================================================

function sanitizeFileName(name) {
    return String(name || "audio")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
}

function isRenderEnvironment() {
    return Boolean(
        process.env.RENDER ||
        process.env.RENDER_SERVICE_ID ||
        process.env.RENDER_EXTERNAL_URL
    );
}

function createSession() {
    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_DURATION
    });

    return token;
}

function parseCookies(req) {
    const header = req.headers.cookie;

    if (!header) {
        return {};
    }

    const cookies = {};

    for (const part of header.split(";")) {
        const index = part.indexOf("=");

        if (index === -1) {
            continue;
        }

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        cookies[key] = decodeURIComponent(value);
    }

    return cookies;
}

function getSession(req) {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];

    if (!token) {
        return null;
    }

    const session = sessions.get(token);

    if (!session) {
        return null;
    }

    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
    }

    return {
        token,
        ...session
    };
}

function isAuthenticated(req) {
    return Boolean(getSession(req));
}

function requireAuth(req, res, next) {
    if (!isAuthenticated(req)) {
        return res.status(401).json({
            success: false,
            error: "Authentication required."
        });
    }

    next();
}

function setSessionCookie(res, token) {
    res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DURATION / 1000}${isRenderEnvironment() ? "; Secure" : ""}`
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${isRenderEnvironment() ? "; Secure" : ""}`
    );
}

// ============================================================
// GOOGLE CREDENTIALS
// ============================================================

function loadLocalGoogleCredentials() {
    if (!fs.existsSync(LOCAL_CREDENTIALS_FILE)) {
        throw new Error(
            `Google credentials file not found:\n${LOCAL_CREDENTIALS_FILE}`
        );
    }

    const raw = fs.readFileSync(
        LOCAL_CREDENTIALS_FILE,
        "utf8"
    );

    const parsed = JSON.parse(raw);

    const oauthConfig =
        parsed.web ||
        parsed.installed ||
        parsed;

    if (!oauthConfig.client_id) {
        throw new Error(
            "Google OAuth client_id is missing."
        );
    }

    if (!oauthConfig.client_secret) {
        throw new Error(
            "Google OAuth client_secret is missing."
        );
    }

    return oauthConfig;
}

function loadLocalToken() {
    if (!fs.existsSync(LOCAL_TOKEN_FILE)) {
        throw new Error(
            `Google token file not found:\n${LOCAL_TOKEN_FILE}`
        );
    }

    const raw = fs.readFileSync(
        LOCAL_TOKEN_FILE,
        "utf8"
    );

    return JSON.parse(raw);
}

// ============================================================
// GOOGLE OAUTH CLIENT
// ============================================================

function createGoogleOAuthClient() {
    let clientId;
    let clientSecret;
    let redirectUri;
    let token;

    // --------------------------------------------------------
    // RENDER
    // --------------------------------------------------------

    if (
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_TOKEN_JSON
    ) {
        clientId =
            process.env.GOOGLE_CLIENT_ID;

        clientSecret =
            process.env.GOOGLE_CLIENT_SECRET;

        redirectUri =
            process.env.GOOGLE_REDIRECT_URI ||
            "urn:ietf:wg:oauth:2.0:oob";

        try {
            token = JSON.parse(
                process.env.GOOGLE_TOKEN_JSON
            );
        } catch {
            throw new Error(
                "GOOGLE_TOKEN_JSON contains invalid JSON."
            );
        }

        log(
            "Using Google credentials from environment variables."
        );
    }

    // --------------------------------------------------------
    // LOCAL
    // --------------------------------------------------------

    else {
        const credentials =
            loadLocalGoogleCredentials();

        token =
            loadLocalToken();

        clientId =
            credentials.client_id;

        clientSecret =
            credentials.client_secret;

        if (
            Array.isArray(
                credentials.redirect_uris
            ) &&
            credentials.redirect_uris.length > 0
        ) {
            redirectUri =
                credentials.redirect_uris[0];
        } else {
            redirectUri =
                "urn:ietf:wg:oauth:2.0:oob";
        }

        log(
            "Using local Google credentials and token."
        );
    }

    const oauth2Client =
        new google.auth.OAuth2(
            clientId,
            clientSecret,
            redirectUri
        );

    oauth2Client.setCredentials(token);

    return oauth2Client;
}

// ============================================================
// GOOGLE DRIVE CLIENT
// ============================================================

async function getDriveClient() {
    const auth =
        createGoogleOAuthClient();

    try {
        await auth.getAccessToken();
    } catch (error) {
        throw new Error(
            `Google authentication failed: ${error.message}`
        );
    }

    return google.drive({
        version: "v3",
        auth
    });
}

// ============================================================
// FIND DRIVE FOLDER
// ============================================================

async function getDriveFolder(drive) {
    const escapedName =
        DRIVE_FOLDER_NAME.replace(
            /'/g,
            "\\'"
        );

    const response =
        await drive.files.list({
            q:
                `'root' in parents ` +
                `and name = '${escapedName}' ` +
                `and mimeType = 'application/vnd.google-apps.folder' ` +
                `and trashed = false`,

            fields:
                "files(id,name,parents)",

            spaces: "drive",

            pageSize: 10
        });

    if (
        response.data.files &&
        response.data.files.length > 0
    ) {
        return response.data.files[0];
    }

    throw new Error(
        `Google Drive folder "${DRIVE_FOLDER_NAME}" was not found in your Drive.`
    );
}

// ============================================================
// RUN COMMAND
// ============================================================

function runCommand(
    command,
    args
) {
    return new Promise(
        (resolve, reject) => {
            const child =
                spawn(
                    command,
                    args,
                    {
                        stdio: [
                            "ignore",
                            "pipe",
                            "pipe"
                        ]
                    }
                );

            let stdout = "";
            let stderr = "";

            if (child.stdout) {
                child.stdout.on(
                    "data",
                    (chunk) => {
                        stdout +=
                            chunk.toString();
                    }
                );
            }

            if (child.stderr) {
                child.stderr.on(
                    "data",
                    (chunk) => {
                        stderr +=
                            chunk.toString();
                    }
                );
            }

            child.on(
                "error",
                (error) => {
                    reject(error);
                }
            );

            child.on(
                "close",
                (code) => {
                    if (code === 0) {
                        resolve({
                            stdout,
                            stderr
                        });
                    } else {
                        reject(
                            new Error(
                                `${command} exited with code ${code}\n${stderr}`
                            )
                        );
                    }
                }
            );
        }
    );
}

// ============================================================
// GET MEDIA TITLE
// ============================================================

async function getMediaTitle(url) {
    log("Getting media title...");

    const result =
        await runCommand(
            "yt-dlp",
            [
                "--ignore-config",
                "--no-playlist",
                "--skip-download",
                "--print",
                "%(title)s",
                url
            ]
        );

    const title =
        result.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .pop();

    if (!title) {
        throw new Error(
            "Could not determine the media title."
        );
    }

    return sanitizeFileName(title);
}

// ============================================================
// CREATE AUDIO STREAM
//
// yt-dlp stdout
//       ↓
//     ffmpeg
//       ↓
//   MP3 stdout
//       ↓
// Google Drive
//
// NO LOCAL MEDIA FILE
// ============================================================

function createAudioStream(url) {
    return new Promise(
        (resolve, reject) => {
            log(
                "Starting yt-dlp stream..."
            );

            const yt =
                spawn(
                    "yt-dlp",
                    [
                        "--ignore-config",
                        "--no-playlist",
                        "--no-progress",
                        "-f",
                        "bestaudio/best",
                        "-o",
                        "-",
                        url
                    ],
                    {
                        stdio: [
                            "ignore",
                            "pipe",
                            "pipe"
                        ]
                    }
                );

            const ffmpeg =
                spawn(
                    "ffmpeg",
                    [
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-i",
                        "pipe:0",
                        "-vn",
                        "-c:a",
                        "libmp3lame",
                        "-b:a",
                        "192k",
                        "-f",
                        "mp3",
                        "pipe:1"
                    ],
                    {
                        stdio: [
                            "pipe",
                            "pipe",
                            "pipe"
                        ]
                    }
                );

            let ytError = "";
            let ffmpegError = "";

            let resolved = false;
            let failed = false;

            function stopProcesses() {
                try {
                    if (
                        yt &&
                        !yt.killed
                    ) {
                        yt.kill(
                            "SIGTERM"
                        );
                    }
                } catch {}

                try {
                    if (
                        ffmpeg &&
                        !ffmpeg.killed
                    ) {
                        ffmpeg.kill(
                            "SIGTERM"
                        );
                    }
                } catch {}
            }

            function fail(error) {
                if (
                    failed ||
                    resolved
                ) {
                    return;
                }

                failed = true;

                stopProcesses();

                reject(error);
            }

            yt.on(
                "error",
                (error) => {
                    fail(
                        new Error(
                            `yt-dlp failed to start: ${error.message}`
                        )
                    );
                }
            );

            ffmpeg.on(
                "error",
                (error) => {
                    fail(
                        new Error(
                            `ffmpeg failed to start: ${error.message}`
                        )
                    );
                }
            );

            yt.stderr.on(
                "data",
                (chunk) => {
                    ytError +=
                        chunk.toString();
                }
            );

            ffmpeg.stderr.on(
                "data",
                (chunk) => {
                    ffmpegError +=
                        chunk.toString();
                }
            );

            // yt-dlp → ffmpeg
            yt.stdout.pipe(
                ffmpeg.stdin
            );

            yt.stdout.on(
                "end",
                () => {
                    if (
                        !ffmpeg.stdin.destroyed
                    ) {
                        ffmpeg.stdin.end();
                    }
                }
            );

            yt.on(
                "close",
                (code) => {
                    if (
                        code !== 0 &&
                        !resolved
                    ) {
                        fail(
                            new Error(
                                `yt-dlp exited with code ${code}\n${ytError}`
                            )
                        );
                    }
                }
            );

            ffmpeg.stdout.once(
                "data",
                () => {
                    if (
                        resolved ||
                        failed
                    ) {
                        return;
                    }

                    resolved = true;

                    resolve({
                        stream:
                            ffmpeg.stdout,

                        yt,

                        ffmpeg
                    });
                }
            );

            ffmpeg.on(
                "close",
                (code) => {
                    if (
                        code !== 0 &&
                        !resolved
                    ) {
                        fail(
                            new Error(
                                `ffmpeg exited with code ${code}\n${ffmpegError}`
                            )
                        );
                    }
                }
            );

            yt.stdout.on(
                "error",
                (error) => {
                    fail(error);
                }
            );

            ffmpeg.stdout.on(
                "error",
                (error) => {
                    fail(error);
                }
            );
        }
    );
}

// ============================================================
// STOP MEDIA PROCESSES
// ============================================================

function stopMediaProcesses(
    media
) {
    if (!media) {
        return;
    }

    try {
        if (
            media.yt &&
            !media.yt.killed
        ) {
            media.yt.kill(
                "SIGTERM"
            );
        }
    } catch {}

    try {
        if (
            media.ffmpeg &&
            !media.ffmpeg.killed
        ) {
            media.ffmpeg.kill(
                "SIGTERM"
            );
        }
    } catch {}
}

// ============================================================
// LOGIN PAGE
// ============================================================

function sendLoginPage(res, errorMessage = "") {
    const errorHtml = errorMessage
        ? `
            <div class="error">
                ${escapeHtml(errorMessage)}
            </div>
        `
        : "";

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>
<title>DriveFromMusic — Login</title>

<style>
* {
    box-sizing: border-box;
}

body {
    margin: 0;
    min-height: 100vh;

    display: flex;
    align-items: center;
    justify-content: center;

    font-family:
        Inter,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

    background:
        radial-gradient(
            circle at top,
            #202020 0%,
            #0c0c0c 45%,
            #000000 100%
        );

    color: #ffffff;
}

.container {
    width: min(430px, 92vw);

    padding: 40px;

    border:
        1px solid
        rgba(255,255,255,0.12);

    border-radius: 24px;

    background:
        rgba(20,20,20,0.88);

    box-shadow:
        0 25px 80px
        rgba(0,0,0,0.55);

    backdrop-filter: blur(18px);
}

.logo {
    width: 64px;
    height: 64px;

    display: flex;
    align-items: center;
    justify-content: center;

    border-radius: 18px;

    background:
        linear-gradient(
            135deg,
            #ff3030,
            #9d0000
        );

    font-size: 30px;

    margin-bottom: 20px;

    box-shadow:
        0 10px 30px
        rgba(255,0,0,0.25);
}

h1 {
    margin: 0;

    font-size: 32px;

    letter-spacing: -1px;
}

.subtitle {
    margin-top: 10px;

    color: #a9a9a9;

    line-height: 1.6;
}

form {
    margin-top: 28px;
}

input {
    width: 100%;

    padding: 16px 18px;

    border-radius: 14px;

    border:
        1px solid
        rgba(255,255,255,0.14);

    outline: none;

    background: #111111;

    color: #ffffff;

    font-size: 16px;
}

input:focus {
    border-color: #ff3333;

    box-shadow:
        0 0 0 3px
        rgba(255,51,51,0.12);
}

button {
    width: 100%;

    margin-top: 14px;

    padding: 16px;

    border: 0;

    border-radius: 14px;

    background:
        linear-gradient(
            135deg,
            #ff3030,
            #c40000
        );

    color: white;

    font-size: 16px;

    font-weight: 700;

    cursor: pointer;
}

button:hover {
    opacity: 0.92;
}

.error {
    margin-top: 18px;

    padding: 14px;

    border-radius: 12px;

    color: #ff9090;

    background:
        rgba(255,50,50,0.08);

    border:
        1px solid
        rgba(255,70,70,0.2);
}

.info {
    margin-top: 24px;

    font-size: 13px;

    color: #777777;

    line-height: 1.6;
}
</style>
</head>

<body>

<main class="container">

    <div class="logo">
        🔒
    </div>

    <h1>
        DriveFromMusic
    </h1>

    <div class="subtitle">
        Private access.<br>
        Enter the password to continue.
    </div>

    ${errorHtml}

    <form method="POST" action="/login">

        <input
            type="password"
            name="password"
            placeholder="Enter password"
            autocomplete="current-password"
            autofocus
            required
        >

        <button type="submit">
            Unlock
        </button>

    </form>

    <div class="info">
        🔐 This website is restricted to authorized users.
    </div>

</main>

</body>
</html>
    `);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ============================================================
// AUTH ROUTES
// ============================================================

app.use(
    express.urlencoded({
        extended: false
    })
);

app.get(
    "/login",
    (req, res) => {
        if (isAuthenticated(req)) {
            return res.redirect("/");
        }

        sendLoginPage(res);
    }
);

app.post(
    "/login",
    (req, res) => {
        const password =
            String(
                req.body.password || ""
            );

        if (
            !APP_PASSWORD ||
            APP_PASSWORD === "changeme"
        ) {
            console.error(
                "[DriveFromMusic] WARNING: APP_PASSWORD is not configured."
            );

            return sendLoginPage(
                res,
                "Website password has not been configured."
            );
        }

        if (
            password.length === 0 ||
            !crypto.timingSafeEqual(
                Buffer.from(password),
                Buffer.from(APP_PASSWORD)
            )
        ) {
            return sendLoginPage(
                res,
                "Incorrect password."
            );
        }

        const token =
            createSession();

        setSessionCookie(
            res,
            token
        );

        log(
            "Successful website login."
        );

        res.redirect("/");
    }
);

app.post(
    "/logout",
    (req, res) => {
        const session =
            getSession(req);

        if (session) {
            sessions.delete(
                session.token
            );
        }

        clearSessionCookie(res);

        res.redirect("/login");
    }
);

// ============================================================
// HEALTH
//
// Health is intentionally public so Render can monitor it.
// ============================================================

app.get(
    "/health",
    async (req, res) => {
        res.json({
            ok: true,

            service:
                "DriveFromMusic",

            environment:
                isRenderEnvironment()
                    ? "render"
                    : "local",

            port: PORT,

            driveFolder:
                DRIVE_FOLDER_NAME,

            streaming: true,

            localMediaFiles:
                false,

            passwordProtection:
                true
        });
    }
);

// ============================================================
// DOWNLOAD ENDPOINT
// ============================================================

app.post(
    "/download",
    requireAuth,
    async (req, res) => {
        let media = null;

        try {
            const {
                url
            } = req.body;

            if (!url) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Please provide a media URL."
                    });
            }

            if (
                typeof url !== "string" ||
                !/^https?:\/\//i.test(url)
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Invalid URL."
                    });
            }

            log(
                "======================================"
            );

            log(
                "New download request"
            );

            log(
                `URL: ${url}`
            );

            log(
                "======================================"
            );

            // ------------------------------------------------
            // GOOGLE DRIVE
            // ------------------------------------------------

            log(
                "Connecting to Google Drive..."
            );

            const drive =
                await getDriveClient();

            log(
                "Google Drive authentication successful."
            );

            // ------------------------------------------------
            // DRIVE FOLDER
            // ------------------------------------------------

            const folder =
                await getDriveFolder(
                    drive
                );

            log(
                `Drive folder found: ${folder.name}`
            );

            // ------------------------------------------------
            // TITLE
            // ------------------------------------------------

            const title =
                await getMediaTitle(
                    url
                );

            const fileName =
                `${title}.mp3`;

            log(
                `File name: ${fileName}`
            );

            // ------------------------------------------------
            // STREAM
            // ------------------------------------------------

            log(
                "Starting streaming pipeline..."
            );

            log(
                "yt-dlp → ffmpeg → Google Drive"
            );

            media =
                await createAudioStream(
                    url
                );

            // ------------------------------------------------
            // GOOGLE DRIVE UPLOAD
            // ------------------------------------------------

            log(
                "Uploading MP3 to Google Drive..."
            );

            const uploaded =
                await drive.files.create({
                    requestBody: {
                        name:
                            fileName,

                        parents: [
                            folder.id
                        ],

                        mimeType:
                            "audio/mpeg"
                    },

                    media: {
                        mimeType:
                            "audio/mpeg",

                        body:
                            media.stream
                    },

                    fields:
                        "id,name,webViewLink,webContentLink"
                });

            log(
                "======================================"
            );

            log(
                "Upload completed successfully."
            );

            log(
                `File: ${uploaded.data.name}`
            );

            log(
                `ID: ${uploaded.data.id}`
            );

            log(
                "======================================"
            );

            stopMediaProcesses(
                media
            );

            media = null;

            return res.json({
                success: true,

                message:
                    "Audio uploaded successfully.",

                file: {
                    id:
                        uploaded.data.id,

                    name:
                        uploaded.data.name,

                    webViewLink:
                        uploaded.data.webViewLink ||
                        null
                }
            });

        } catch (error) {
            console.error("");

            console.error(
                "======================================"
            );

            console.error(
                "DOWNLOAD ERROR"
            );

            console.error(
                "======================================"
            );

            console.error(error);

            console.error(
                "======================================"
            );

            console.error("");

            stopMediaProcesses(
                media
            );

            return res
                .status(500)
                .json({
                    success: false,

                    error:
                        error &&
                        error.message
                            ? error.message
                            : "Unknown server error."
                });
        }
    }
);

// ============================================================
// WEBSITE
// ============================================================

app.get(
    "/",
    (req, res) => {

        if (!isAuthenticated(req)) {
            return res.redirect(
                "/login"
            );
        }

        res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>
    DriveFromMusic
</title>

<style>

* {
    box-sizing: border-box;
}

body {

    margin: 0;

    min-height: 100vh;

    display: flex;

    align-items: center;

    justify-content: center;

    font-family:
        Inter,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

    background:
        radial-gradient(
            circle at top,
            #202020 0%,
            #0c0c0c 45%,
            #000000 100%
        );

    color: #ffffff;
}

.container {

    width: min(
        700px,
        92vw
    );

    padding: 42px;

    border:
        1px solid
        rgba(
            255,
            255,
            255,
            0.12
        );

    border-radius: 24px;

    background:
        rgba(
            20,
            20,
            20,
            0.85
        );

    box-shadow:
        0 25px 80px
        rgba(
            0,
            0,
            0,
            0.55
        );

    backdrop-filter:
        blur(18px);

}

.topbar {

    display: flex;

    align-items: center;

    justify-content: space-between;

    gap: 20px;

}

.logo {

    width: 64px;

    height: 64px;

    display: flex;

    align-items: center;

    justify-content: center;

    border-radius: 18px;

    background:
        linear-gradient(
            135deg,
            #ff3030,
            #9d0000
        );

    font-size: 30px;

    margin-bottom: 20px;

    box-shadow:
        0 10px 30px
        rgba(
            255,
            0,
            0,
            0.25
        );

}

.logout {

    width: auto;

    margin: 0;

    padding:
        10px
        15px;

    border: 1px solid
        rgba(
            255,
            255,
            255,
            0.12
        );

    border-radius: 10px;

    background: #151515;

    color: #aaa;

    font-size: 13px;

    cursor: pointer;

}

.logout:hover {

    color: white;

    border-color:
        rgba(
            255,
            255,
            255,
            0.25
        );

}

h1 {

    margin: 0;

    font-size: 36px;

    letter-spacing: -1px;

}

.subtitle {

    margin-top: 10px;

    color: #a9a9a9;

    line-height: 1.6;

}

.input-area {

    margin-top: 30px;

}

input {

    width: 100%;

    padding:
        16px
        18px;

    border-radius: 14px;

    border:
        1px solid
        rgba(
            255,
            255,
            255,
            0.14
        );

    outline: none;

    background: #111111;

    color: #ffffff;

    font-size: 16px;

}

input:focus {

    border-color:
        #ff3333;

    box-shadow:
        0 0 0 3px
        rgba(
            255,
            51,
            51,
            0.12
        );

}

.upload {

    width: 100%;

    margin-top: 14px;

    padding: 16px;

    border: 0;

    border-radius: 14px;

    background:
        linear-gradient(
            135deg,
            #ff3030,
            #c40000
        );

    color: white;

    font-size: 16px;

    font-weight: 700;

    cursor: pointer;

    transition:
        transform 0.15s,
        opacity 0.15s;

}

.upload:hover {

    transform:
        translateY(-1px);

}

.upload:disabled {

    opacity: 0.5;

    cursor:
        not-allowed;

    transform:
        none;

}

.status {

    margin-top: 22px;

    padding: 16px;

    border-radius: 14px;

    background: #101010;

    border:
        1px solid
        rgba(
            255,
            255,
            255,
            0.08
        );

    color: #bdbdbd;

    white-space:
        pre-wrap;

    display:
        none;

}

.status.show {

    display:
        block;

}

.status.success {

    color:
        #8dffb1;

    border-color:
        rgba(
            70,
            255,
            130,
            0.2
        );

}

.status.error {

    color:
        #ff9090;

    border-color:
        rgba(
            255,
            70,
            70,
            0.2
        );

}

.info {

    margin-top: 26px;

    font-size: 13px;

    line-height: 1.6;

    color: #777777;

}

.info strong {

    color:
        #a0a0a0;

}

</style>

</head>

<body>

<main class="container">

    <div class="topbar">

        <div class="logo">
            🎵
        </div>

        <form
            method="POST"
            action="/logout"
        >

            <button
                class="logout"
                type="submit"
            >
                Logout
            </button>

        </form>

    </div>

    <h1>
        DriveFromMusic
    </h1>

    <div class="subtitle">

        Convert online media to MP3
        and send it directly to
        your Google Drive.

    </div>

    <div class="input-area">

        <input
            id="url"
            type="url"
            placeholder="Paste media URL here..."
            autocomplete="off"
        >

        <button
            class="upload"
            id="downloadButton"
            type="button"
        >
            Upload to Google Drive
        </button>

    </div>

    <div
        id="status"
        class="status"
    ></div>

    <div class="info">

        <strong>
            Streaming architecture:
        </strong>

        <br>

        URL → yt-dlp → ffmpeg → Google Drive

        <br>
        <br>

        No MP3 file is intentionally
        created on your laptop.

        <br>
        <br>

        🔐 Private access enabled.

    </div>

</main>

<script>

const urlInput =
    document.getElementById(
        "url"
    );

const button =
    document.getElementById(
        "downloadButton"
    );

const status =
    document.getElementById(
        "status"
    );

function showStatus(
    message,
    type = ""
) {

    status.textContent =
        message;

    status.className =
        "status show " + type;
}

button.addEventListener(
    "click",
    async function () {

        const url =
            urlInput.value.trim();

        if (!url) {

            showStatus(
                "Please paste a URL first.",
                "error"
            );

            return;
        }

        button.disabled =
            true;

        showStatus(
            [
                "Processing...",
                "",
                "yt-dlp → ffmpeg → Google Drive",
                "",
                "Please wait."
            ].join(
                String.fromCharCode(10)
            )
        );

        try {

            const response =
                await fetch(
                    "/download",
                    {
                        method:
                            "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                url:
                                    url
                            })
                    }
                );

            let data;

            try {

                data =
                    await response.json();

            } catch {

                throw new Error(
                    "The server returned an invalid response."
                );

            }

            if (
                response.status === 401
            ) {

                window.location.href =
                    "/login";

                return;

            }

            if (
                !response.ok ||
                !data.success
            ) {

                throw new Error(
                    data.error ||
                    "Upload failed."
                );

            }

            showStatus(
                [
                    "✓ Upload completed!",
                    "",
                    "File: " +
                        data.file.name,
                    "",
                    "The MP3 has been uploaded to your DriveFromMusic folder."
                ].join(
                    String.fromCharCode(10)
                ),
                "success"
            );

            urlInput.value = "";

        } catch (error) {

            showStatus(
                [
                    "✕ Upload failed.",
                    "",
                    error.message
                ].join(
                    String.fromCharCode(10)
                ),
                "error"
            );

        } finally {

            button.disabled =
                false;

        }

    }
);

urlInput.addEventListener(
    "keydown",
    function (event) {

        if (
            event.key === "Enter" &&
            !button.disabled
        ) {

            button.click();

        }

    }
);

</script>

</body>

</html>
        `);
    }
);

// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({
            success: false,

            error:
                "Route not found."
        });

    }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled Express error:",
            error
        );

        if (
            res.headersSent
        ) {
            return next(error);
        }

        res.status(500).json({
            success: false,

            error:
                "Internal server error."
        });

    }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    HOST,
    () => {

        console.log("");

        console.log(
            "======================================"
        );

        console.log(
            "🎵 DriveFromMusic"
        );

        console.log(
            "======================================"
        );

        console.log("");

        console.log(
            `🌐 Server running on port ${PORT}`
        );

        console.log(
            `📡 Host: ${HOST}`
        );

        console.log(
            `📁 Drive folder: ${DRIVE_FOLDER_NAME}`
        );

        console.log(
            "💾 Local media files: DISABLED"
        );

        console.log(
            "🔄 Streaming: yt-dlp → ffmpeg → Drive"
        );

        console.log(
            "🔐 Password protection: ENABLED"
        );

        if (
            isRenderEnvironment()
        ) {

            console.log(
                "☁️ Environment: Render"
            );

        } else {

            console.log(
                "💻 Environment: Local"
            );

        }

        console.log("");

        console.log(
            "======================================"
        );

        console.log("");

    }
);