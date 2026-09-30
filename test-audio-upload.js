const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.join(__dirname, "credentials", "google-credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

async function main() {
    console.log("======================================");
    console.log("🎧 DriveFromMusic Audio Test");
    console.log("======================================");

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));

    const config = credentials.installed || credentials.web;
    const { client_id, client_secret } = config;

    const auth = new google.auth.OAuth2(
        client_id,
        client_secret,
        "http://localhost:3000/oauth2callback"
    );

    auth.setCredentials(token);

    const drive = google.drive({
        version: "v3",
        auth
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "drivefrommusic-"));
    const wavPath = path.join(tempDir, "DriveFromMusic-Test.wav");
    const mp3Path = path.join(tempDir, "DriveFromMusic-Test.mp3");

    try {
        console.log("\n🎵 Creating test audio...");

        const wav = spawnSync("ffmpeg", [
            "-y",
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=3",
            "-c:a", "pcm_s16le",
            wavPath
        ], {
            stdio: "inherit"
        });

        if (wav.status !== 0) {
            throw new Error("FFmpeg failed while creating WAV");
        }

        console.log("✅ WAV created");

        console.log("\n🎶 Converting to MP3...");

        const mp3 = spawnSync("ffmpeg", [
            "-y",
            "-i", wavPath,
            "-codec:a", "libmp3lame",
            "-b:a", "192k",
            mp3Path
        ], {
            stdio: "inherit"
        });

        if (mp3.status !== 0) {
            throw new Error("FFmpeg failed while converting to MP3");
        }

        console.log("✅ MP3 created");

        console.log("\n☁️ Finding DriveFromMusic folder...");

        const folderSearch = await drive.files.list({
            q: "name = 'DriveFromMusic' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: "files(id,name)"
        });

        let folderId;

        if (folderSearch.data.files.length > 0) {
            folderId = folderSearch.data.files[0].id;
            console.log("✅ Folder found");
        } else {
            const folder = await drive.files.create({
                requestBody: {
                    name: "DriveFromMusic",
                    mimeType: "application/vnd.google-apps.folder"
                },
                fields: "id,name"
            });

            folderId = folder.data.id;
            console.log("✅ Folder created");
        }

        console.log("\n☁️ Uploading MP3...");

        const upload = await drive.files.create({
            requestBody: {
                name: "DriveFromMusic-Test.mp3",
                parents: [folderId],
                mimeType: "audio/mpeg"
            },
            media: {
                mimeType: "audio/mpeg",
                body: fs.createReadStream(mp3Path)
            },
            fields: "id,name,webViewLink"
        });

        console.log("\n======================================");
        console.log("🎉 AUDIO UPLOAD SUCCESS!");
        console.log("======================================");
        console.log("File:", upload.data.name);
        console.log("ID:", upload.data.id);
        console.log("Link:", upload.data.webViewLink || "Available in Google Drive");
        console.log("======================================");

    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log("\n🧹 Temporary files cleaned up");
    }
}

main().catch(error => {
    console.error("\n❌ Audio test failed:");
    console.error(error.message);
    process.exit(1);
});
