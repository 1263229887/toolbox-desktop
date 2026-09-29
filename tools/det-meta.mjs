import * as ort from 'onnxruntime-web'
ort.env.wasm.wasmPaths = '/tmp/ortmin/'
const s = await ort.InferenceSession.create('/tmp/wmsp/det.onnx', { logSeverityLevel: 3 })
console.log('det inputs :', JSON.stringify(s.inputMetadata))
console.log('det outputs:', JSON.stringify(s.outputMetadata))
