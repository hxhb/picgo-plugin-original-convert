'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const createPlugin = require('..')

function createContext (config = {}) {
  const hooks = {}
  const logs = []
  const ctx = {
    output: [],
    getConfig: key => key === 'picgo-plugin-original-convert' ? config : undefined,
    log: {
      info: message => logs.push(message),
      warn: message => logs.push(message),
      error: message => logs.push(message)
    },
    helper: {
      beforeUploadPlugins: { register: (name, hook) => { hooks.before = hook } },
      afterUploadPlugins: { register: (name, hook) => { hooks.after = hook } }
    }
  }
  createPlugin(ctx).register()
  return { ctx, hooks, logs }
}

async function makeJpeg (color = '#ff0000') {
  return sharp({ create: { width: 8, height: 6, channels: 3, background: color } }).jpeg().toBuffer()
}

async function makePng () {
  return sharp({ create: { width: 5, height: 7, channels: 4, background: '#00ff0088' } }).png().toBuffer()
}

function markUploaded (output, reorder = false) {
  const uploaded = output.map(item => ({ ...item, buffer: undefined, imgUrl: `https://img.invalid/${encodeURIComponent(item.fileName)}` }))
  return reorder ? uploaded.reverse() : uploaded
}

test('uploads original and WebP, then returns only WebP', async () => {
  const { ctx, hooks } = createContext()
  const originalBuffer = await makeJpeg()
  ctx.output = [{ fileName: '2026/09/photo.JPG', extname: '.JPG', buffer: originalBuffer }]

  await hooks.before.handle(ctx)
  assert.deepEqual(ctx.output.map(item => item.fileName), ['2026/09/photo.JPG', '2026/09/photo.webp'])
  assert.strictEqual(ctx.output[0].buffer, originalBuffer)
  assert.equal((await sharp(ctx.output[1].buffer).metadata()).format, 'webp')
  assert.equal(ctx.output[1].width, 8)
  assert.equal(ctx.output[1].height, 6)

  ctx.output = markUploaded(ctx.output)
  hooks.after.handle(ctx)
  assert.deepEqual(ctx.output.map(item => item.fileName), ['2026/09/photo.webp'])
  assert.equal(Object.keys(ctx.output[0]).some(key => key.startsWith('__originalConvert')), false)
})

test('supports mixed batches and restores input order after uploader reordering', async () => {
  const { ctx, hooks } = createContext()
  ctx.output = [
    { fileName: 'A.jpg', extname: '.jpg', buffer: await makeJpeg('#112233') },
    { fileName: 'B.png', extname: '.png', buffer: await makePng() },
    { fileName: 'C.webp', extname: '.webp', buffer: Buffer.from('passthrough') },
    { fileName: 'D.gif', extname: '.gif', buffer: Buffer.from('passthrough') }
  ]

  await hooks.before.handle(ctx)
  assert.deepEqual(ctx.output.map(item => item.fileName), ['A.jpg', 'A.webp', 'B.png', 'B.webp', 'C.webp', 'D.gif'])
  ctx.output = markUploaded(ctx.output, true)
  hooks.after.handle(ctx)
  assert.deepEqual(ctx.output.map(item => item.fileName), ['A.webp', 'B.webp', 'C.webp', 'D.gif'])
})

test('rejects derived-name collisions before upload', async () => {
  const { ctx, hooks } = createContext()
  ctx.output = [
    { fileName: 'photo.jpg', extname: '.jpg', buffer: await makeJpeg() },
    { fileName: 'photo.png', extname: '.png', buffer: await makePng() }
  ]
  await assert.rejects(hooks.before.handle(ctx), /target filename conflict.*photo\.webp/)
})

test('rejects a derivative colliding with an existing passthrough WebP', async () => {
  const { ctx, hooks } = createContext()
  ctx.output = [
    { fileName: 'photo.jpg', extname: '.jpg', buffer: await makeJpeg() },
    { fileName: 'photo.webp', extname: '.webp', buffer: Buffer.from('existing') }
  ]
  await assert.rejects(hooks.before.handle(ctx), /target filename conflict.*photo\.webp/)
})

test('fails when uploader drops one result', async () => {
  const { ctx, hooks } = createContext()
  ctx.output = [{ fileName: 'photo.jpg', extname: '.jpg', buffer: await makeJpeg() }]
  await hooks.before.handle(ctx)
  ctx.output = markUploaded(ctx.output).slice(0, 1)
  assert.throws(() => hooks.after.handle(ctx), /expected 2 results, received 1/)
})

test('matches uploader results by filename when custom markers are lost', async () => {
  const { ctx, hooks } = createContext()
  ctx.output = [{ fileName: 'photo.jpg', extname: '.jpg', buffer: await makeJpeg() }]
  await hooks.before.handle(ctx)
  ctx.output = ctx.output.map(item => ({ fileName: item.fileName, imgUrl: `https://opaque.invalid/${Math.random()}` })).reverse()
  hooks.after.handle(ctx)
  assert.deepEqual(ctx.output.map(item => item.fileName), ['photo.webp'])
})

test('disabled mode leaves uploader input and output untouched', async () => {
  const { ctx, hooks } = createContext({ enabled: false })
  const item = { fileName: 'photo.jpg', extname: '.jpg', buffer: await makeJpeg() }
  ctx.output = [item]
  await hooks.before.handle(ctx)
  assert.deepEqual(ctx.output, [item])
  ctx.output = markUploaded(ctx.output)
  hooks.after.handle(ctx)
  assert.equal(ctx.output.length, 1)
  assert.equal(ctx.output[0].fileName, 'photo.jpg')
})

test('enforces max input size', async () => {
  const { ctx, hooks } = createContext({ maxInputSizeMB: 1 })
  ctx.output = [{ fileName: 'large.jpg', extname: '.jpg', buffer: Buffer.alloc(1024 * 1024 + 1) }]
  await assert.rejects(hooks.before.handle(ctx), /exceeds maxInputSizeMB/)
})
