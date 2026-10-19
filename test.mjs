// dshx-loop-guard 的离线单元测试。
// 不启动 DSH，而是用一个假的 ctx 收集插件注册的事件处理函数，再手动模拟
// "发请求 -> 工具执行前 -> 工具执行 -> 工具执行后" 的流程。
// 运行（需先设置 SCHEMASTERY_PATH，见 test-resolve.mjs）：
//   node --import ./test-resolve.mjs test.mjs
import assert from 'node:assert/strict'
import { apply } from './index.js'

/**
 * 搭一个最小测试环境：加载插件、造一个使用 local provider 的假 agent。
 * @param config - 传给插件的配置
 * @returns request() 模拟一次模型请求；call() 模拟一次完整的工具调用；
 *          nextTurn() 进入下一轮；cancelled 读取插件是否中止了本轮
 */
function harness(config) {
  // 插件通过 ctx.on 注册的处理函数都存到这里，按事件名索引
  const handlers = {}
  const ctx = {
    on: (ev, fn) => { handlers[ev] = fn },
    inject: () => {}, // 测试里不需要 webServer
    logger: () => ({ info() {}, warn() {} }),
  }
  apply(ctx, config)
  let cancelled = null
  // 假 agent：只需要 options.provider 和 cancel()
  const agent = { options: { provider: 'local' }, cancel: (c) => { cancelled = c } }
  let turn = 1

  /** 模拟一次模型请求，让插件记录 provider 和当前轮次。 */
  async function request() {
    await handlers['agent/request']({ agent, turn }, async () => ({ provider: 'local', model: 'm' }))
  }

  /**
   * 模拟一次完整的工具调用：pre-execute ->（被拒绝则生成错误结果，否则生成正常结果）-> post-execute。
   * @param name - 工具名
   * @param args - 工具参数
   * @param output - 工具"执行"后返回的文本
   * @returns denied：是否被拒绝；text：模型最终看到的结果文本
   */
  async function call(name, args, output) {
    const exec = { name, arguments: args, agent }
    const pre = await handlers['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    let result
    if (pre.kind === 'deny') result = { isError: true, content: [{ type: 'text', text: pre.reason }] }
    else result = { isError: false, value: output, content: [{ type: 'text', text: String(output) }] }
    const post = await handlers['tools/post-execute'](exec, result, async () => ({ kind: 'accept' }))
    const content = post.content ?? result.content
    return { denied: pre.kind === 'deny', text: content.map((b) => b.text).join('') }
  }
  return { request, call, agent, nextTurn: () => { turn += 1 }, get cancelled() { return cancelled } }
}

// 测试 1：参数相同、结果也相同 —— 第 3 次提醒，第 5 次拒绝，拒绝满 3 次后中止本轮
{
  const h = harness({})
  await h.request()
  const r = []
  for (let i = 0; i < 8; i++) r.push(await h.call('run_python', { code: 'x' }, 'same'))
  assert.equal(r[0].text.includes('loop-guard'), false)
  assert.equal(r[1].text.includes('loop-guard'), false)
  assert.equal(r[2].text.includes('第 3 次'), true, 'warn at 3rd')
  assert.equal(r[3].denied, false)
  assert.equal(r[4].denied, true, 'deny at 5th')
  assert.equal(r[5].denied, true, 'stays denied')
  assert.equal(r[6].denied, true)
  // 中止是用 setTimeout 推迟执行的，稍等一下再检查
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(h.cancelled?.kind, 'hook', 'cancel after 3 denials')
}
// 测试 2：参数相同但结果每次不同（模拟改代码后重跑测试）—— 永远不提醒、不拒绝
{
  const h = harness({})
  await h.request()
  for (let i = 0; i < 10; i++) {
    const r = await h.call('run_tests', {}, `result ${i}`)
    assert.equal(r.denied, false)
    assert.equal(r.text.includes('loop-guard'), false)
  }
}
// 测试 3：参数的键顺序不同，仍然算同一个调用
{
  const h = harness({})
  await h.request()
  await h.call('read', { a: 1, b: 2 }, 'r')
  await h.call('read', { b: 2, a: 1 }, 'r')
  const r = await h.call('read', { a: 1, b: 2 }, 'r')
  assert.equal(r.text.includes('第 3 次'), true)
}
// 测试 4：进入新的一轮后，计数清零
{
  const h = harness({})
  await h.request()
  for (let i = 0; i < 4; i++) await h.call('x', {}, 's')
  h.nextTurn(); await h.request()
  const r = await h.call('x', {}, 's')
  assert.equal(r.denied, false)
  assert.equal(r.text.includes('loop-guard'), false)
}
// 测试 5：默认只管 local，其他 provider（这里是 claude）完全不受影响
{
  const handlers = {}
  apply({ on: (e, f) => { handlers[e] = f }, inject() {}, logger: () => ({ info() {} }) }, {})
  const agent = { options: { provider: 'claude' }, cancel() {} }
  await handlers['agent/request']({ agent, turn: 1 }, async () => ({ provider: 'claude', model: 'o' }))
  for (let i = 0; i < 8; i++) {
    const pre = await handlers['tools/pre-execute']({ name: 'x', arguments: {}, agent }, async () => ({ kind: 'allow' }))
    assert.equal(pre.kind, 'allow')
    await handlers['tools/post-execute']({ name: 'x', arguments: {}, agent }, { isError: false, content: [{ type: 'text', text: 's' }] }, async () => ({ kind: 'accept' }))
  }
}
// 测试 6：hardLimit —— 参数相同、结果在两种之间交替（连续计数永远到不了阈值），超过总次数上限后拒绝
{
  const h = harness({ hardLimit: 6 })
  await h.request()
  const out = []
  for (let i = 0; i < 8; i++) out.push(await h.call('y', {}, i % 2 ? 'a' : 'b'))
  assert.equal(out[5].denied, false)
  assert.equal(out[6].denied, true, 'deny 7th when hardLimit=6')
}
// 测试 7：并行调用（真实复现的 bug）—— 模型一次发出 8 个相同调用，
// DSH 先对 8 个调用全部做执行前检查、再统一执行和处理结果。
// 修复前 8 个全部放行；修复后应放行前 4 个、拒绝后 4 个，并中止本轮。
{
  const handlers = {}
  apply({ on: (e, f) => { handlers[e] = f }, inject() {}, logger: () => ({ info() {}, warn() {} }) }, {})
  let cancelled = null
  const agent = { options: { provider: 'local' }, cancel: (c) => { cancelled = c } }
  await handlers['agent/request']({ agent, turn: 1 }, async () => ({ provider: 'local', model: 'm' }))
  // 每个调用有自己的 token（DSH 里由注册表分配）
  const execs = Array.from({ length: 8 }, (_, i) => ({ name: 'read', arguments: { path: 'p' }, agent, token: Symbol(`c${i}`) }))
  // 第一阶段：全部执行前检查
  const pres = []
  for (const e of execs) pres.push(await handlers['tools/pre-execute'](e, async () => ({ kind: 'allow' })))
  assert.deepEqual(pres.map((p) => p.kind), ['allow', 'allow', 'allow', 'allow', 'deny', 'deny', 'deny', 'deny'])
  // 第二阶段：全部处理结果（被拒绝的返回错误）
  for (let i = 0; i < 8; i++) {
    const result = pres[i].kind === 'deny'
      ? { isError: true, content: [{ type: 'text', text: pres[i].reason }] }
      : { isError: false, content: [{ type: 'text', text: 'same' }] }
    await handlers['tools/post-execute'](execs[i], result, async () => ({ kind: 'accept' }))
  }
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(cancelled?.kind, 'hook', 'parallel loop cancels the turn')
}
console.log('all loop-guard tests passed')
