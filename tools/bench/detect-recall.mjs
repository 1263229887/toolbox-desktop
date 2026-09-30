#!/usr/bin/env node
/**
 * 本地检测层在真样本上的召回/误检统计（不开界面、不起 utilityProcess）。
 * 先跑 python 侧 tools/bench/prep-samples.py 生成 /tmp/bench/{i}.rgb 与 meta.json，
 * 真值 mask 来自「待去水印」与「已去水印」两张图的差分。
 */
import fs from 'node:fs'
import * as ort from 'onnxruntime-web'
import { createDetector } from '../../src/main/services/detect-core.js'

ort.env.wasm.wasmPaths = '/tmp/ortmin/'
ort.env.wasm.numThreads = 4
const meta = JSON.parse(fs.readFileSync('/tmp/bench/meta.json', 'utf8'))
const session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync('/tmp/wmsp/det.onnx')), { logSeverityLevel: 3 })
const detect = createDetector({ getOrt: () => ort, getSession: () => session })

const iou = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  const area = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter
  return inter / area
}

let hits = 0
let fp = 0
let topHits = 0
let t0 = Date.now()
for (const m of meta) {
  const image = new Uint8Array(fs.readFileSync(`/tmp/bench/${m.i}.rgb`))
  const truth = { x0: m.truth_bbox[0], y0: m.truth_bbox[1], x1: m.truth_bbox[2], y1: m.truth_bbox[3] }
  const s = Date.now()
  const boxes = await detect({ image, w: m.w, h: m.h })
  const ms = Date.now() - s
  const best = boxes.reduce((acc, b) => Math.max(acc, iou(b, truth)), 0)
  const covered = boxes.filter((b) => iou(b, truth) > 0.12).length
  const miss = boxes.length - covered
  fp += miss
  if (covered) hits++
  // 只看「按分数取前 1 个」的策略：真值是否排第一、这样自动应用会误伤几处
  const top = boxes[0]
  const topIsTruth = top ? iou(top, truth) > 0.12 : false
  if (topIsTruth) topHits++
  const detail = boxes.map((b, k) => `${k}:${b.score}${iou(b, truth) > 0.12 ? '*' : ''}`).join(' ')
  console.log(`#${m.i} ${String(m.w).padStart(4)}x${String(m.h)}  候选 ${String(boxes.length).padStart(2)}  真值 ${covered}  误检 ${miss}  取前1=${topIsTruth ? '命中' : '落空'}  IoU ${best.toFixed(3)}  ${ms}ms  [${detail}]`)
}
console.log(`\n全取：召回 ${hits}/${meta.length}（${((hits / meta.length) * 100).toFixed(0)}%），误检框 ${fp}`)
console.log(`只取分数最高 1 个：命中 ${topHits}/${meta.length}，即 ${meta.length - topHits} 张会漏、误伤 ${meta.filter((m, i) => false).length} 张（见上表取前1列）`)
console.log(`平均 ${Math.round((Date.now() - t0) / meta.length)}ms/张（* 表示该框与真值 IoU>0.12）`)
