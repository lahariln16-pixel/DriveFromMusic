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

async function uploadTestFile() {
    const filePath = path.join(
        __dirname,
        "DriveFromMusic_Test.txt"
    );

    fs.writeFileSync(
        filePath,
        "DriveFromMusic Google Drive upload test successful! 🎵"
    );

    console.log("Uploading test file...");

    const response = await drive.files.create({
        requestBody: {
            name: "DriveFromMusic_Test.txt",
            mimeType: "text/plain"
        },

        media: {
            mimeType: "text/plain",
            body: fs.createReadStream(filePath)
        },

        fields: "id,name,webViewLink"
    });

    console.log("");
    console.log("=================================");
    console.log("UPLOAD SUCCESSFUL! 🎉");
    console.log("=================================");
    console.log("File:", response.data.name);
    console.log("ID:", response.data.id);
    console.log("Link:", response.data.webViewLink);
    console.log("=================================");

    fs.unlinkSync(filePath);
}

uploadTestFile().catch((error) => {
    console.error("");
    console.error("UPLOAD FAILED");
    console.error(error.response?.data || error.message);
});

