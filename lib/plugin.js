'use strict'

const sharp = require('sharp')

const PLUGIN_ID = 'original-convert'
const CONFIG_KEY = 'picgo-plugin-original-convert'
const TOKEN_KEY = '__originalConvertToken'
const BATCH_KEY = '__originalConvertBatch'
const CONVERTIBLE = new Set(['.jpg', '.jpeg', '.png'])

const DEFAULTS = Object.freeze({
  enabled: true,
  jpegQuality: 82,
  webpEffort: 4,
  pngLossless: true,
  maxInputSizeMB: 50,
  concurrency: 2
})

function clampInteger (value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function asBoolean (value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function getOptions (ctx) {
  const raw = ctx.getConfig(CONFIG_KEY) || {}
  return {
    enabled: asBoolean(raw.enabled, DEFAULTS.enabled),
    jpegQuality: clampInteger(raw.jpegQuality, DEFAULTS.jpegQuality, 1, 100),
    webpEffort: clampInteger(raw.webpEffort, DEFAULTS.webpEffort, 0, 6),
    pngLossless: asBoolean(raw.pngLossless, DEFAULTS.pngLossless),
    maxInputSizeMB: clampInteger(raw.maxInputSizeMB, DEFAULTS.maxInputSizeMB, 1, 2048),
    concurrency: clampInteger(raw.concurrency, DEFAULTS.concurrency, 1, 16)
  }
}

function getExtension (fileName, declaredExtension) {
  const match = String(fileName || '').match(/(\.[^./\\]+)$/)
  return (match ? match[1] : declaredExtension || '').toLowerCase()
}

function replaceExtension (fileName, extension) {
  const value = String(fileName || '')
  return /\.[^./\\]+$/.test(value)
    ? value.replace(/\.[^./\\]+$/, extension)
    : `${value}${extension}`
}

function getBuffer (item) {
  if (Buffer.isBuffer(item.buffer)) return item.buffer
  if (typeof item.base64Image === 'string' && item.base64Image.length > 0) {
    const payload = item.base64Image.replace(/^data:[^;]+;base64,/, '')
    return Buffer.from(payload, 'base64')
  }
  return null
}

function createToken (batchId, index, role) {
  return `${batchId}:${index}:${role}`
}

function setMarker (item, batchId, token) {
  // Enumerable fields survive uploaders that shallow-clone PicGo output items.
  item[BATCH_KEY] = batchId
  item[TOKEN_KEY] = token
  return item
}

async function mapLimit (items, concurrency, mapper) {
  const results = new Array(items.length)
  let cursor = 0

  async function worker () {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

async function convertToWebP (buffer, extension, options) {
  const image = sharp(buffer, { failOn: 'error' }).rotate()
  if (extension === '.png' && options.pngLossless) {
    return image.webp({ lossless: true, effort: options.webpEffort }).toBuffer({ resolveWithObject: true })
  }
  return image.webp({
    quality: options.jpegQuality,
    effort: options.webpEffort,
    smartSubsample: true
  }).toBuffer({ resolveWithObject: true })
}

function validateOutputNames (plans) {
  const owners = new Map()
  for (const plan of plans) {
    for (const name of plan.uploadNames) {
      if (owners.has(name)) {
        throw new Error(`target filename conflict: "${name}" is produced by both input #${owners.get(name) + 1} and input #${plan.index + 1}`)
      }
      owners.set(name, plan.index)
    }
  }
}

function makePlans (output) {
  return output.map((item, index) => {
    if (!item || typeof item.fileName !== 'string' || item.fileName.length === 0) {
      throw new Error(`input #${index + 1} has no valid fileName`)
    }
    const extension = getExtension(item.fileName, item.extname)
    const convertible = CONVERTIBLE.has(extension)
    const derivedName = convertible ? replaceExtension(item.fileName, '.webp') : null
    return {
      index,
      item,
      extension,
      convertible,
      originalName: item.fileName,
      derivedName,
      uploadNames: convertible ? [item.fileName, derivedName] : [item.fileName]
    }
  })
}

function hasUploadUrl (item) {
  return typeof item.imgUrl === 'string' && item.imgUrl.length > 0
}

function normalizedName (item) {
  return item && typeof item.fileName === 'string' ? item.fileName : null
}

function scoreBatch (batch, output) {
  let score = 0
  const names = new Set(batch.expected.map(item => item.fileName))
  for (const item of output) {
    if (item && item[BATCH_KEY] === batch.id) score += 100
    else if (item && batch.tokens.has(item[TOKEN_KEY])) score += 50
    else if (names.has(normalizedName(item))) score += 1
  }
  return score
}

function takeBatch (pendingBatches, output) {
  if (pendingBatches.length === 0) return null
  let bestIndex = 0
  let bestScore = scoreBatch(pendingBatches[0], output)
  for (let index = 1; index < pendingBatches.length; index++) {
    const score = scoreBatch(pendingBatches[index], output)
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }
  return pendingBatches.splice(bestIndex, 1)[0]
}

function matchUploadedItem (uploaded, expected, consumed) {
  let index = uploaded.findIndex((item, candidateIndex) =>
    !consumed.has(candidateIndex) && item && item[TOKEN_KEY] === expected.token
  )
  if (index < 0) {
    index = uploaded.findIndex((item, candidateIndex) =>
      !consumed.has(candidateIndex) && normalizedName(item) === expected.fileName
    )
  }
  if (index >= 0) consumed.add(index)
  return index >= 0 ? uploaded[index] : null
}

function config (ctx) {
  const current = getOptions(ctx)
  return [
    { name: 'enabled', type: 'confirm', alias: '启用插件', default: current.enabled, message: 'Upload original images together with WebP derivatives' },
    { name: 'jpegQuality', type: 'input', alias: 'JPEG 转 WebP 质量', default: current.jpegQuality, message: '1-100' },
    { name: 'webpEffort', type: 'input', alias: 'WebP 编码强度', default: current.webpEffort, message: '0-6' },
    { name: 'pngLossless', type: 'confirm', alias: 'PNG 使用无损 WebP', default: current.pngLossless, message: 'Encode PNG derivatives as lossless WebP' },
    { name: 'maxInputSizeMB', type: 'input', alias: '单图大小上限（MB）', default: current.maxInputSizeMB, message: 'Reject larger convertible images' },
    { name: 'concurrency', type: 'input', alias: '转换并发数', default: current.concurrency, message: '1-16' }
  ]
}

function createPlugin (ctx) {
  const pendingBatches = []
  let nextBatchId = 1

  const beforeUpload = {
    async handle (hookCtx) {
      const output = Array.isArray(hookCtx.output) ? hookCtx.output : []
      const options = getOptions(hookCtx)
      const batchId = `${Date.now().toString(36)}-${nextBatchId++}`

      if (!options.enabled || output.length === 0) {
        pendingBatches.push({ id: batchId, active: false, expected: [], tokens: new Set() })
        return hookCtx
      }

      const plans = makePlans(output)
      validateOutputNames(plans)
      const maxBytes = options.maxInputSizeMB * 1024 * 1024

      const expanded = await mapLimit(plans, options.concurrency, async plan => {
        const originalToken = createToken(batchId, plan.index, 'original')
        const original = setMarker(plan.item, batchId, originalToken)

        if (!plan.convertible) {
          return {
            objects: [original],
            expected: [{ inputIndex: plan.index, role: 'return', fileName: plan.originalName, token: originalToken }]
          }
        }

        const sourceBuffer = getBuffer(plan.item)
        if (!sourceBuffer) throw new Error(`no image buffer available for "${plan.originalName}"`)
        if (sourceBuffer.length > maxBytes) {
          throw new Error(`"${plan.originalName}" exceeds maxInputSizeMB (${options.maxInputSizeMB} MB)`)
        }

        let derivedBuffer
        try {
          derivedBuffer = await convertToWebP(sourceBuffer, plan.extension, options)
        } catch (error) {
          throw new Error(`WebP conversion failed for "${plan.originalName}": ${error.message}`)
        }

        const derivedToken = createToken(batchId, plan.index, 'derived')
        const derived = setMarker({
          ...plan.item,
          fileName: plan.derivedName,
          extname: '.webp',
          buffer: derivedBuffer.data,
          base64Image: undefined,
          imgUrl: undefined,
          width: derivedBuffer.info.width,
          height: derivedBuffer.info.height
        }, batchId, derivedToken)

        return {
          objects: [original, derived],
          expected: [
            { inputIndex: plan.index, role: 'original', fileName: plan.originalName, token: originalToken },
            { inputIndex: plan.index, role: 'return', fileName: plan.derivedName, token: derivedToken }
          ]
        }
      })

      const expected = expanded.flatMap(item => item.expected)
      pendingBatches.push({ id: batchId, active: true, expected, tokens: new Set(expected.map(item => item.token)) })
      hookCtx.output = expanded.flatMap(item => item.objects)
      hookCtx.log.info(`[${PLUGIN_ID}] batch=${batchId} input=${plans.length} upload=${hookCtx.output.length} derived=${plans.filter(item => item.convertible).length}`)
      return hookCtx
    }
  }

  const afterUpload = {
    handle (hookCtx) {
      const uploaded = Array.isArray(hookCtx.output) ? hookCtx.output : []
      const batch = takeBatch(pendingBatches, uploaded)
      if (!batch) throw new Error(`[${PLUGIN_ID}] no matching upload batch context`)
      if (!batch.active) return hookCtx

      if (uploaded.length !== batch.expected.length) {
        throw new Error(`[${PLUGIN_ID}] uploader compatibility error: expected ${batch.expected.length} results, received ${uploaded.length}`)
      }

      const consumed = new Set()
      const matched = batch.expected.map(expected => ({
        expected,
        item: matchUploadedItem(uploaded, expected, consumed)
      }))
      const missing = matched.filter(entry => !entry.item || !hasUploadUrl(entry.item))
      if (missing.length > 0) {
        const names = missing.map(entry => entry.expected.fileName).join(', ')
        throw new Error(`[${PLUGIN_ID}] upload validation failed or uploader is incompatible; missing successful results: ${names}`)
      }

      hookCtx.output = matched
        .filter(entry => entry.expected.role === 'return')
        .sort((a, b) => a.expected.inputIndex - b.expected.inputIndex)
        .map(entry => {
          delete entry.item[BATCH_KEY]
          delete entry.item[TOKEN_KEY]
          return entry.item
        })

      hookCtx.log.info(`[${PLUGIN_ID}] batch=${batch.id} validation=success returned=${hookCtx.output.length}`)
      return hookCtx
    }
  }

  return {
    register () {
      ctx.helper.beforeUploadPlugins.register(PLUGIN_ID, { handle: beforeUpload.handle, config, name: '原图与 WebP 双份上传' })
      ctx.helper.afterUploadPlugins.register(PLUGIN_ID, { handle: afterUpload.handle, name: '仅返回派生图片' })
    },
    config
  }
}

module.exports = {
  createPlugin,
  _internals: {
    CONFIG_KEY,
    DEFAULTS,
    TOKEN_KEY,
    BATCH_KEY,
    getOptions,
    replaceExtension,
    mapLimit,
    validateOutputNames
  }
}
