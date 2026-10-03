// 浏览器端保存文件（仅 DOM，无逻辑）：把文本或字节作为下载交给浏览器 / Electron。
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export function saveText({ filename, mime, text }) {
  saveBlob(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }), filename)
}

export function saveBytes({ filename, mime, bytes }) {
  saveBlob(new Blob([bytes], { type: mime || 'application/octet-stream' }), filename)
}

/** 下载一个文件为字节；非 2xx 抛错，让素材包把它记为“跳过” */
export async function fetchBytes(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
