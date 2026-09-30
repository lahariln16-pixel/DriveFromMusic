const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const credentials = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, "credentials", "google-credentials.json"),
        "utf8"
    )
);

const token = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, "token.json"),
        "utf8"
    )
);

const { client_id, client_secret, redirect_uris } = credentials.web;

const auth = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
);

auth.setCredentials(token);

const drive = google.drive({
    version: "v3",
    auth
});

async function main() {
    console.log("Searching for DriveFromMusic folder...");

    const result = await drive.files.list({
        q: "name = 'DriveFromMusic' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: "files(id,name,webViewLink)"
    });

    if (result.data.files.length > 0) {
        const folder = result.data.files[0];

        console.log("");
        console.log("====================================");
        console.log("📁 DriveFromMusic folder found!");
        console.log("====================================");
        console.log("Name:", folder.name);
        console.log("ID:", folder.id);
        console.log("====================================");

        return folder.id;
    }

    console.log("Folder doesn't exist.");
    console.log("Creating DriveFromMusic folder...");

    const folder = await drive.files.create({
        requestBody: {
            name: "DriveFromMusic",
            mimeType: "application/vnd.google-apps.folder"
        },
        fields: "id,name,webViewLink"
    });

    console.log("");
    console.log("====================================");
    console.log("🎉 Folder created!");
    console.log("====================================");
    console.log("Name:", folder.data.name);
    console.log("ID:", folder.data.id);
    console.log("====================================");

    return folder.data.id;
}

main().catch((error) => {
    console.error("");
    console.error("❌ Drive error:");
    console.error(error.response?.data || error.message);
});
