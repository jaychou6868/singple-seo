FROM node:22-slim
# fonts-noto-cjk: Sharp/librsvg uses fontconfig to find fonts when rendering
# SVG <text>. Without CJK fonts, Chinese characters render as .notdef
# (□ tofu boxes). Karen 2026-04-07 v29 caught this — the SVG title overlay
# was producing tofu boxes in production. fc-cache rebuilds the font index
# so librsvg sees the new fonts immediately.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl fonts-noto-cjk fontconfig && \
    fc-cache -f && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production
CMD ["node", "dist/index.js"]
