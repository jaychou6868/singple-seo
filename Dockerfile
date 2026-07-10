FROM node:22-slim
# fonts-noto-cjk + fontconfig: Karen 2026-04-07 v30 — bundled @font-face
# data URL approach (commit f4fe249) didn't render in librsvg, text came
# out as tofu boxes. Install Noto CJK system-wide so fontconfig finds it
# directly without needing to parse the embedded base64 font.
# ffmpeg: 2026-07-10 Gemini→OpenAI 遷移後，影片理解改為服務端抽音軌轉錄＋截圖
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl fonts-noto-cjk fontconfig ffmpeg && \
    fc-cache -f && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production
CMD ["node", "dist/index.js"]
