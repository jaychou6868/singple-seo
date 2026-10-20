// 觀眾看得到的字一律寫「酸」（酸痛、喉嚨酸），不寫「痠」（Karen 2026-10-20 定案）。
// OpenCC s2twp 會把「酸痛」轉成「痠痛」、模型也偶爾自己寫「痠」，所以輸出端統一換掉當安全網。
// 這個檔沒有副作用，測試可以直接 import。
export function fixSourChar(text: string): string {
  return text.replace(/痠/g, '酸');
}
