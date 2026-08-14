FROM node:22-slim
# fonts-noto-cjk + fontconfig: Karen 2026-04-07 v30 — bundled @font-face
# data URL approach (commit f4fe249) didn't render in librsvg, text came
# out as tofu boxes. Install Noto CJK system-wide so fontconfig finds it
# directly without needing to parse the embedded base64 font.
# ffmpeg: 2026-07-10 Gemini→OpenAI 遷移後，影片理解改為服務端抽音軌轉錄＋截圖
# python3 + venv: 2026-08-14 轉錄改為容器內 faster-whisper（見下方）
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl fonts-noto-cjk fontconfig ffmpeg python3 python3-venv && \
    fc-cache -f && \
    rm -rf /var/lib/apt/lists/*

# ── 容器內語音轉錄 ──────────────────────────────────────────
# 2026-08-14：OpenAI 按量帳號餘額歸零，轉錄整條壞掉；文字生成已改走 ChatGPT
# 訂閱橋接，但訂閱端點沒有轉錄介面，所以轉錄改成在本容器內跑本地模型。
#
# ⚠️ 一定要用 venv：Debian bookworm 的 python3 是 PEP 668 externally-managed，
#    直接 pip install 會被擋（error: externally-managed-environment）。
RUN python3 -m venv /opt/venv
COPY requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ⚠️ 模型烘進映像檔，不要改成執行期下載。
#    這功能大約一週用一次，容器早就冷掉了；改成執行期下載等於每次都讓 Karen
#    等 1.6GB，而且多一個 HuggingFace 連不上就整支失敗的外部依賴。
#    用 download_model 而不是 WhisperModel(...)：前者只下載檔案，後者會把
#    1.6GB 權重載進記憶體做 int8 量化，建置階段可能因此 OOM。
RUN /opt/venv/bin/python -c "\
from faster_whisper.utils import download_model; \
print(download_model('large-v3-turbo', output_dir='/opt/whisper-model'))"

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production
CMD ["node", "dist/index.js"]
