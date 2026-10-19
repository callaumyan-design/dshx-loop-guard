// dshx-loop-guard —— 防止 agent（主要是本地小模型）陷入"反复调用同一个工具"的死循环。
//
// 挂载的扩展点（都是 DSH 公开的事件，不改动 agent 主循环）：
//   agent/request      （waterfall）记录每个 agent 当前用的是哪个 provider/模型、第几轮
//   tools/pre-execute  （waterfall）工具执行前：判断是否该拒绝这次调用
//   tools/post-execute （waterfall）工具执行后：比较结果，重复时在结果后附加提醒
//
// 判定规则（按 agent 分别统计，每一轮重新计数）：
//   1. 调用指纹 = 工具名 + 参数（参数按键名排序后序列化，键顺序不同也算同一个调用）。
//   2. 同一指纹连续返回"一模一样"的结果：
//        第 warnAt 次相同结果 —— 照常返回，但在结果末尾附加提醒；
//        第 stopAt 次相同调用 —— 直接拒绝，不执行。
//   3. 同一指纹在一轮内执行满 hardLimit 次（不管结果是否相同）—— 之后的调用拒绝。
//   4. 一轮内工具调用总数超过 maxCallsPerTurn（0 = 不限）—— 拒绝。
//   5. 一轮内累计被拒绝 maxDenials 次 —— 直接中止本轮。
// 改完文件再跑同一条测试命令不算循环：结果变了，连续计数会清零。
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/** 插件名，同时用作日志前缀和 cordis.patch.yml 里的 name。 */
export const name = 'dshx-loop-guard'

/**
 * 插件配置的校验规则（在 cordis.patch.yml 的 config 段里填写）。
 * 每一项都有默认值，不写就用默认值。
 */
export const Config = z.object({
  providers: z.array(z.string()).default(['local'])
    .description('只对这些 provider 生效；留空数组 = 对所有模型生效'),
  warnAt: z.number().default(3).description('同一调用第几次得到相同结果时开始警告'),
  stopAt: z.number().default(5).description('同一调用第几次（结果都相同）时拒绝执行'),
  hardLimit: z.number().default(12).description('同一调用一轮内最多执行次数（不管结果）'),
  maxCallsPerTurn: z.number().default(0).description('一轮内工具调用总数上限，0 = 不限'),
  maxDenials: z.number().default(3).description('一轮内被拒绝几次后直接中止本轮'),
})

/**
 * 本插件写进模型可见文本里的标记。
 * 用途：①让模型知道提醒来自谁；②比较结果时把自己加的提醒剥掉；③识别"这是我们自己的拒绝"。
 */
const MARK = '【dshx-loop-guard】'

/**
 * 把任意 JSON 值转成"规范化"字符串：对象的键按字母排序。
 * 这样 {a:1,b:2} 和 {b:2,a:1} 会得到同一个字符串，从而得到同一个指纹。
 * @param value - 工具参数或内容块等任意 JSON 值
 * @returns 规范化后的字符串
 */
function canonical(value) {
  // 数组：保持顺序，逐个元素递归规范化
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  // 对象：键排序后逐个递归规范化
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  // 基本类型直接序列化；undefined 序列化结果是 undefined，统一当作 null
  return JSON.stringify(value) ?? 'null'
}

/**
 * 计算短哈希，用来代替长字符串做比较和存储，省内存。
 * @param text - 要哈希的文本
 * @returns 16 位十六进制哈希
 */
function hash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * 把一次工具结果转成用于比较的文本。
 * 会去掉本插件自己附加的提醒，否则"加了提醒的结果"和"原结果"会被误判为不同。
 * @param result - 工具执行结果（含 content 和 isError）
 * @returns 可比较的文本：前缀 E/O 表示失败/成功，后面是所有内容块
 */
function resultText(result) {
  const parts = []
  for (const block of result?.content ?? []) {
    // 文本块：截掉 "\n\n【dshx-loop-guard】..." 之后的部分
    if (block?.type === 'text') parts.push(String(block.text).split(`\n\n${MARK}`)[0])
    // 其他块（图片等）：整体规范化后参与比较
    else parts.push(canonical(block))
  }
  return `${result?.isError ? 'E' : 'O'}|${parts.join('\n')}`
}

/**
 * 读取一个非负整数配置；不合法（小数、负数、非数字）时返回默认值。
 * @param v - 配置里填的值
 * @param d - 默认值
 * @returns 合法的非负整数
 */
function posInt(v, d) {
  return Number.isSafeInteger(v) && v >= 0 ? v : d
}

/**
 * 插件入口：DSH 加载插件时调用一次。
 * 通过 ctx.on 注册的监听器在插件卸载时会被自动移除，无需手动清理。
 * @param ctx - Cordis 上下文
 * @param config - 经过 Config 校验后的配置
 */
export function apply(ctx, config = {}) {
  // —— 读取并修正配置，保证各阈值之间的大小关系合理 ——
  const providers = Array.isArray(config.providers) ? config.providers : ['local']
  // 至少第 2 次才提醒（第 1 次谈不上重复）
  const warnAt = Math.max(2, posInt(config.warnAt, 3))
  // 拒绝不能早于提醒
  const stopAt = Math.max(warnAt, posInt(config.stopAt, 5))
  // 总次数上限不能小于拒绝阈值
  const hardLimit = Math.max(stopAt, posInt(config.hardLimit, 12))
  const maxCallsPerTurn = posInt(config.maxCallsPerTurn, 0)
  // 至少拒绝 1 次才中止
  const maxDenials = Math.max(1, posInt(config.maxDenials, 3))
  const logger = ctx.logger?.(name)

  /**
   * agent -> { provider, model, turn }：从 agent/request 观察到的当前路由和轮次。
   * 用 WeakMap：agent 被销毁后条目自动回收，不会内存泄漏。
   */
  const routes = new WeakMap()
  /**
   * agent -> 本轮统计状态：
   *   turn      —— 这份状态属于第几轮（轮次变了就重建）
   *   calls     —— 本轮工具调用总数
   *   denials   —— 本轮已拒绝次数
   *   cancelled —— 本轮是否已经触发过中止（避免重复中止）
   *   byCall    —— 指纹 -> { count: 执行次数, streak: 连续相同结果数-1, last: 上次结果哈希,
   *                          pending: 已放行但还没返回结果的调用数（并行调用时 > 0） }
   */
  const states = new WeakMap()
  /**
   * 本插件放行、正在执行中的调用：调用标识 -> 指纹。
   * 执行后（post-execute）据此把对应的 pending 减一。
   * 调用标识优先用 DSH 分配的 exec.token，没有时退回 exec 对象本身。
   */
  const inFlight = new Map()
  /** 全局累计统计，供 /dshx-loop-guard/status 查看。recent 保留最近 30 条事件。 */
  const stats = { warnings: 0, denials: 0, cancels: 0, recent: [] }

  /**
   * 记一条事件到 stats.recent（最新的在最前面，最多 30 条）。
   * @param kind - 'warn' 提醒 / 'deny' 拒绝 / 'cancel' 中止本轮
   * @param agent - 触发事件的 agent
   * @param toolName - 相关工具名
   * @param detail - 说明文字
   */
  function record(kind, agent, toolName, detail) {
    const r = routes.get(agent)
    stats.recent.unshift({ at: new Date().toISOString(), kind, tool: toolName, provider: r?.provider, model: r?.model, detail })
    stats.recent.length = Math.min(stats.recent.length, 30)
  }

  /**
   * 判断这个 agent 是否在监控范围内（看它当前用的 provider 是否在配置列表里）。
   * @param agent - 发起工具调用的 agent
   * @returns 是否需要监控
   */
  function watched(agent) {
    // 没有 agent 的调用（例如系统内部调用）一律不管
    if (agent === undefined) return false
    // providers 为空数组 = 监控所有模型
    if (providers.length === 0) return true
    // 优先用最近一次请求实际使用的 provider（会话中途可能换模型），没有再退回创建时的配置
    const provider = routes.get(agent)?.provider ?? agent.options?.provider
    return typeof provider === 'string' && providers.includes(provider)
  }

  /**
   * 取得该 agent 本轮的统计状态；如果已经进入新的一轮，就新建一份（实现"每轮清零"）。
   * @param agent - 目标 agent
   * @returns 本轮状态对象
   */
  function stateFor(agent) {
    const turn = routes.get(agent)?.turn
    let s = states.get(agent)
    if (s === undefined || s.turn !== turn) {
      s = { turn, calls: 0, denials: 0, cancelled: false, byCall: new Map() }
      states.set(agent, s)
    }
    return s
  }

  /**
   * 生成一个"拒绝"决定，并在本轮拒绝次数达到上限时安排中止本轮。
   * @param agent - 被拒绝的 agent
   * @param s - 该 agent 本轮状态
   * @param toolName - 被拒绝的工具名
   * @param reason - 拒绝原因（会展示给模型）
   * @returns tools/pre-execute 的 deny 决定
   */
  function deny(agent, s, toolName, reason) {
    s.denials += 1
    stats.denials += 1
    record('deny', agent, toolName, reason)
    logger?.info?.('deny %s: %s', toolName, reason)
    // 本轮拒绝次数达到上限，且还没中止过 -> 中止本轮
    if (s.denials >= maxDenials && !s.cancelled) {
      s.cancelled = true
      stats.cancels += 1
      record('cancel', agent, toolName, `denied ${s.denials} times this turn`)
      // 用 setTimeout 推迟到当前 waterfall 返回之后再中止，避免在事件处理中途打断工具管线
      setTimeout(() => {
        try {
          // kind: 'hook' 表示由插件发起的中止，reason 会记录在会话里
          agent.cancel({ kind: 'hook', reason: `${name}: tool loop detected (${toolName})` })
        } catch (error) {
          logger?.warn?.('cancel failed: %s', error?.message ?? error)
        }
      }, 0)
    }
    return {
      kind: 'deny',
      // 这段文字会作为工具错误结果返回给模型，告诉它该怎么做
      reason: `${MARK}${reason} 这个调用没有被执行。不要再重复它：如果任务已经完成，就停止调用工具，直接用几句话总结；否则换一个不同的思路。`,
    }
  }

  // —— 扩展点 1：agent/request ——
  // 每次向模型发请求前触发。这里只"观察"：先交给后面的监听器决定最终配置，
  // 再记下实际使用的 provider/模型和轮次，原样返回，不改变任何请求内容。
  ctx.on('agent/request', async (payload, next) => {
    const cfg = await next()
    try {
      routes.set(payload.agent, { provider: cfg?.provider, model: cfg?.model, turn: payload.turn })
    } catch { /* 只是记录，出错也不能影响正常请求 */ }
    return cfg
  })

  // —— 扩展点 2：tools/pre-execute ——
  // 工具真正执行之前触发。返回 next() = 放行；返回 deny 决定 = 不执行，直接把原因作为错误结果给模型。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    // 只管模型直接发起的调用；有 parent 的是组合工具（如 run_code）内部的子调用，归属于外层那次调用
    if (exec.parent !== undefined || !watched(agent)) return next()
    const s = stateFor(agent)
    s.calls += 1
    // 计算本次调用的指纹，找到（或新建）对应的计数条目
    const fp = hash(`${exec.name}\u0000${canonical(exec.arguments)}`)
    let entry = s.byCall.get(fp)
    if (entry === undefined) {
      entry = { count: 0, streak: 0, last: undefined, pending: 0 }
      s.byCall.set(fp, entry)
    }
    entry.count += 1
    // 规则 4：本轮工具调用总数超限
    if (maxCallsPerTurn > 0 && s.calls > maxCallsPerTurn) {
      return deny(agent, s, exec.name, `本轮工具调用已超过 ${maxCallsPerTurn} 次上限。`)
    }
    // 规则 2：这次是不是"第 stopAt 次相同调用"。
    // identical = 已经拿到的连续相同结果数（还没拿到过结果时为 0；streak 存的是"连续相同数 - 1"）。
    // 再加上 pending：模型一次并行发出多个相同调用时，DSH 会先对全部调用做执行前检查、
    // 再统一执行，这时前面的调用都还没有结果。把它们按"会得到相同结果"预先计入，
    // 否则并行发出的相同调用会全部被放行。
    const identical = entry.last === undefined ? 0 : entry.streak + 1
    const nth = identical + entry.pending + 1
    if (nth >= stopAt) {
      return deny(agent, s, exec.name, `${exec.name} 用完全相同的参数已经重复调用 ${nth - 1} 次，结果没有变化。`)
    }
    // 规则 3：同一调用本轮执行次数超过硬上限（防止两种结果来回交替的循环）
    if (entry.count > hardLimit) {
      return deny(agent, s, exec.name, `${exec.name} 用相同参数在本轮已调用 ${entry.count} 次，超过上限 ${hardLimit}。`)
    }
    // 都没触发：先交给后面的监听器（其他插件可能还会拒绝）
    const decision = await next()
    // 只有最终真的放行了，才记为"执行中"
    if (decision?.kind !== 'deny') {
      entry.pending += 1
      inFlight.set(exec.token ?? exec, fp)
    }
    return decision
  })

  // —— 扩展点 3：tools/post-execute ——
  // 工具执行完之后触发。先让后面的监听器做决定，再根据结果更新"连续相同"计数，
  // 达到提醒阈值时在结果末尾附加一段提醒文字。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const agent = exec.agent
    if (exec.parent !== undefined || !watched(agent)) return decision
    const s = stateFor(agent)
    const fp = hash(`${exec.name}\u0000${canonical(exec.arguments)}`)
    const entry = s.byCall.get(fp)
    // 这次调用已经有结果了，不再算"执行中"（不管结果被怎么处理，都要先减掉）
    const key = exec.token ?? exec
    if (inFlight.has(key)) {
      inFlight.delete(key)
      if (entry !== undefined && entry.pending > 0) entry.pending -= 1
    }
    // 其他插件已经把结果改成 block 的，不处理
    if (decision?.kind !== 'accept') return decision
    // 没有对应条目（例如本轮刚切换、pre-execute 时还没开始监控），跳过
    if (entry === undefined) return decision
    // 我们自己拒绝产生的错误结果不能算"新结果"，否则会把连续计数清零，导致拒绝失效
    if (result?.isError && (result.content ?? []).some((b) => b?.type === 'text' && String(b.text).includes(MARK))) return decision
    // 和上次结果比较：相同则连续计数 +1，不同则清零
    const rh = hash(resultText(result))
    entry.streak = entry.last === rh ? entry.streak + 1 : 0
    entry.last = rh
    // 还没到提醒阈值（第 warnAt 次相同结果对应 streak = warnAt-1）
    if (entry.streak < warnAt - 1) return decision
    stats.warnings += 1
    record('warn', agent, exec.name, `same result x${entry.streak + 1}`)
    // 在已有内容基础上追加提醒：如果其他插件已经替换过 content，就以替换后的为准
    const base = decision.content ?? result.content ?? []
    const note = `\n\n${MARK}你已经第 ${entry.streak + 1} 次用完全相同的参数调用 ${exec.name}，结果和上次一模一样，没有任何新信息。`
      + `请换个思路；如果任务已经完成，就停止调用工具并写总结。第 ${stopAt} 次相同调用将被拒绝执行。`
    // 优先拼接到最后一个文本块后面；如果最后一块不是文本（例如图片），就单独加一个文本块
    let appended = false
    const content = base.map((b, i) => {
      if (!appended && b?.type === 'text' && i === base.length - 1) { appended = true; return { ...b, text: `${b.text}${note}` } }
      return b
    })
    if (!appended) content.push({ type: 'text', text: note.trimStart() })
    // DSH 规定 accept 决定不能同时替换 value 和 content，所以去掉 value，只替换 content
    const { value: _drop, ...rest } = decision
    return { ...rest, kind: 'accept', content }
  })

  // —— 状态查看接口 ——
  // 在 DSH 的网页服务上注册 GET /dshx-loop-guard/status，返回当前配置和统计。
  // ctx.inject 保证 webServer 服务可用时才注册；scope.effect 保证插件卸载时自动注销这个路由。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dshx-loop-guard/status',
      handler: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ active: true, config: { providers, warnAt, stopAt, hardLimit, maxCallsPerTurn, maxDenials }, ...stats }, null, 1))
      },
    }), 'dshx-loop-guard-status')
  })

  logger?.info?.('loop guard active for %s', providers.length ? providers.join(',') : 'all providers')
}
