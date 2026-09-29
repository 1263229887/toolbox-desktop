import * as ort from 'onnxruntime-web'
const s = await ort.InferenceSession.create('/tmp/wmsp/migan_pipeline_v2.onnx', { logSeverityLevel: 3 })
const keys = [...new Set(Object.keys(s).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(s))))]
console.log('session keys:', keys.join(','))
for (const p of ['inputMetadata', 'outputMetadata']) console.log(p, JSON.stringify(s[p]))
console.log('inputNames', s.inputNames, 'outputNames', s.outputNames)
