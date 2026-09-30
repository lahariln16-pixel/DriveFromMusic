FROM node:24-bookworm

RUN apt-get update \
    && apt-get install -y python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages -U yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
