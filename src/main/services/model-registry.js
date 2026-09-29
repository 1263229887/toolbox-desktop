/**
 * 宿主自带的模型包登记表（不进安装包，首次用到才下载）。
 * 选型记录（2026-09-29 本机实测，同一张样本、同一份 mask）：
 *   MI-GAN migan_pipeline_v2.onnx 28MB / LICENSE-WEIGHTS 实测为 MIT（权重可再分发）/
 *   pipeline 内置「按 mask 紧裁 + 512 缩放」预处理 / WASM 单张 0.6s。
 *   对比过的 LaMa(ONNX) 198MB：同一张图上文字位置留墨绿涂抹，且预处理要自己实现，故未采用。
 * 地址用 ModelScope（国内直连可达，实测 200），不用 HuggingFace（/resolve 直连本机超时）。
 */
export const MODEL_PACKS = {
  migan: {
    id: 'migan',
    name: 'MI-GAN 图像修复',
    version: '1.0.0',
    summary: '去水印工具的修复层，约 31 MB，仅首次使用时下载',
    // 由 tools/pack-model.mjs 生成，内容：MI-GAN pipeline + OCR 文字检测 + ort-web(wasm) 运行时 + 许可证
    url: 'https://github.com/1263229887/toolbox-desktop/releases/download/model-migan-1.0.0/migan-1.0.0.zip',
    sha256: '216e50cd1288cb771be7ee145c7e53deda7593edcc17482d63e4809355ebea9c',
    size: 32873384,
    files: {
      inpaint: 'migan_pipeline_v2.onnx',
      inpaintSha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
      detect: 'ch_PP-OCRv4_det_mobile.onnx',
    },
    licenses: ['LICENSE-MI-GAN.txt', 'LICENSE-MI-GAN-WEIGHTS.txt', 'NOTICE-OCR.txt'],
  },
}

export function packDir(id) {
  return { ...MODEL_PACKS[id], dir: id }
}
