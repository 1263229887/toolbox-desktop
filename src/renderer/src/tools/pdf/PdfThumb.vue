<script setup>
import { onMounted, ref, watch } from 'vue'
import { renderPage, serialize } from './preview.js'

const props = defineProps({
  pdf: { type: Object, default: null },
  index: { type: Number, required: true },
  rotate: { type: Number, default: 0 },
  width: { type: Number, default: 128 },
})

const cv = ref(null)
const failed = ref(false)

async function paint() {
  if (!props.pdf || !cv.value) return
  try {
    failed.value = false
    await serialize(async () => {
      const page = await props.pdf.getPage(props.index + 1)
      const rotation = (((page.rotate + props.rotate) % 360) + 360) % 360
      await renderPage(page, cv.value, props.width, null, { rotation })
    })
  } catch {
    failed.value = true
  }
}

onMounted(paint)
watch(() => [props.pdf, props.rotate], paint)
</script>

<template>
  <div class="overflow-hidden rounded border border-surface-line bg-white">
    <canvas ref="cv" class="block" />
    <p v-if="failed" class="muted py-4 text-center text-11px">渲染失败</p>
  </div>
</template>
