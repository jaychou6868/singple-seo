#!/usr/bin/env python3
"""建置期把 whisper 權重抓進映像檔。只在 Dockerfile 裡跑一次，執行期用不到。

為什麼是獨立檔案而不是 Dockerfile 裡的 python -c：
Zeabur 的 zbpack-v2 會先「預處理」Dockerfile（實測傳給 buildkit 的檔案從
2KB 變成 11KB），過程中會把跨行的引號字串拆壞，導致 dockerfile parse error。
寫成檔案就沒有引號與續行可以被拆。

為什麼用 download_model 而不是 WhisperModel(...)：
前者只把檔案抓下來，後者會把 1.6GB 權重載進記憶體做 int8 量化，
建置階段可能因此 OOM——而且建置期量化的結果根本不會被保存。
"""

import sys

from faster_whisper.utils import download_model

# 模型名稱交給 faster-whisper 自己的對應表解析（large-v3-turbo →
# mobiuslabsgmbh/faster-whisper-large-v3-turbo）。不要在這裡寫死 repo id：
# 版本鎖在 requirements.txt，對應表就是唯一真相。
name = sys.argv[1] if len(sys.argv) > 1 else "large-v3-turbo"
out = sys.argv[2] if len(sys.argv) > 2 else "/opt/whisper-model"

print(f"downloading {name} -> {out}", flush=True)
print(download_model(name, output_dir=out), flush=True)
