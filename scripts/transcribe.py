#!/usr/bin/env python3
"""
容器內語音轉錄（faster-whisper）——取代 OpenAI /v1/audio/transcriptions。

2026-08-14：Karen 的 OpenAI 按量帳號餘額歸零（429 credit_balance_exhausted），
影片 SEO 的轉錄整條是壞的。文字生成已改走 ChatGPT 訂閱橋接，但訂閱端點
沒有轉錄介面，所以轉錄改成在本容器內跑本地模型——免費、無外部依賴。

用法：
    python3 transcribe.py <audio-file>

輸出（stdout，每行一個 JSON；stderr 留給模型自己的雜訊）：
    {"type":"progress","seconds":12.5}   ← 已轉錄到音檔的第幾秒
    {"type":"result","text":"...","language":"zh","duration":301.2}
失敗一律非 0 結束碼，訊息寫 stderr。

⚠️ 兩個容易被「順手改掉」的設定，改了會壞：

1. condition_on_previous_text=False
   Karen 的影片有大量歌唱與伴奏段。開著條件化時，whisper 會把前一段結果
   餵回去當提示，遇到音樂就進入複讀迴圈（整段狂刷同一句）。關掉會讓
   長句連貫性略降，但換到的是不會整支影片報廢。

2. 繁體轉換（OpenCC s2twp）
   whisper 的 zh 輸出是簡體。舊逐字稿（gpt-4o-mini-transcribe）是繁體，
   且這份逐字稿會存進 seo_jobs.transcript 給前端顯示。不轉換 = Karen
   一眼就看到整頁變簡體。initial_prompt 只能「偏向」繁體，不保證，
   所以一定要有 OpenCC 這道確定性的轉換。
"""

import json
import os
import sys


# 模型與執行參數都可用環境變數覆蓋——萬一容器記憶體不夠，
# 改 WHISPER_MODEL=medium（或 small）就能降級，不用改程式碼重新部署。
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR", "/opt/whisper-model")
MODEL_NAME = os.environ.get("WHISPER_MODEL", "")  # 有值就蓋掉 MODEL_DIR
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "zh")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
# 別讓執行緒數超過容器實際拿得到的核心數——超額只會互搶，反而更慢。
CPU_THREADS = int(os.environ.get("WHISPER_THREADS", "0")) or min(4, os.cpu_count() or 1)

# 繁體＋歌唱教學詞彙的提示。作用是把輸出往繁體和本領域用詞推
# （混聲、頭聲、聲帶閉合這類詞，模型預設容易轉成同音別字）。
INITIAL_PROMPT = os.environ.get(
    "WHISPER_INITIAL_PROMPT",
    "以下是一段歌唱教學影片的內容，包含唱歌技巧、發聲練習、換氣、共鳴、"
    "混聲、頭聲、胸聲、聲帶閉合、咬字，以及老師與學生的對話和歌曲演唱。",
)


def emit(obj):
    """一行一個 JSON 丟給 Node 端；一定要 flush，否則進度會卡在管線緩衝區裡，
    長影片就會超過 seo-routes 的 30 分鐘殭屍守衛被判定中斷。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio-file>", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"audio file not found: {audio_path}", file=sys.stderr)
        return 2

    from faster_whisper import WhisperModel

    # 印出實際跑的規格。轉錄慢的時候第一個要問的就是「容器到底拿到幾核」，
    # 沒有這行就只能猜（Zeabur 的資源上限查不到、進不去容器）。
    emit(
        {
            "type": "env",
            "cpu_count": os.cpu_count(),
            "threads": CPU_THREADS,
            "model": MODEL_NAME or MODEL_DIR,
            "compute": COMPUTE_TYPE,
            "beam": BEAM_SIZE,
        }
    )

    model_ref = MODEL_NAME or MODEL_DIR
    model = WhisperModel(
        model_ref,
        device="cpu",
        compute_type=COMPUTE_TYPE,
        cpu_threads=CPU_THREADS,
    )

    segments, info = model.transcribe(
        audio_path,
        language=LANGUAGE,
        beam_size=BEAM_SIZE,
        initial_prompt=INITIAL_PROMPT,
        condition_on_previous_text=False,  # 見檔頭說明，不要改成 True
        vad_filter=True,
        # 門檻放寬到 0.2：預設 0.5 會把音量較小的哼唱／氣音判成非語音丟掉，
        # 而唱歌內容正是這支流程要的東西。寧可多留一點雜訊也不要漏內容。
        vad_parameters={"threshold": 0.2, "min_silence_duration_ms": 1000},
        word_timestamps=False,
    )

    # segments 是 generator——邊轉錄邊吐，所以進度是真的進度而不是估的。
    parts = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            parts.append(text)
        emit({"type": "progress", "seconds": round(seg.end, 2)})

    raw = " ".join(parts).strip()
    emit(
        {
            "type": "result",
            "text": to_traditional(raw),
            "language": info.language,
            "duration": round(info.duration, 2),
        }
    )
    return 0


def to_traditional(text):
    """簡體 → 台灣繁體（含慣用詞轉換）。

    OpenCC 載入失敗時回傳原文而不是讓整支任務死掉：簡體逐字稿雖然不好看，
    但仍然可用來生成文案；為了字體問題讓 Karen 整支影片跑不出來並不划算。
    這是「降級」不是「掩蓋錯誤」——所以一定要在 stderr 留下痕跡。
    """
    if not text:
        return text
    try:
        from opencc import OpenCC

        return OpenCC("s2twp").convert(text)
    except Exception as err:  # noqa: BLE001
        print(f"[transcribe] OpenCC 轉繁體失敗，輸出保持原樣: {err}", file=sys.stderr)
        return text


if __name__ == "__main__":
    sys.exit(main())
