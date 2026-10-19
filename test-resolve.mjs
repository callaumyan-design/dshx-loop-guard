// 仅供测试使用的模块解析钩子。
// 插件目录下没有 node_modules（插件运行时由 DSH 提供依赖），单独跑 test.mjs 时会找不到
// @deepseek-ai/schemastery。这里把它重定向到环境变量 SCHEMASTERY_PATH 指向的文件
// （DSH 配置目录里那份），其他模块照常解析。
// 用法：node --import ./test-resolve.mjs test.mjs
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// 目标文件的 file:// URL
const target = pathToFileURL(process.env.SCHEMASTERY_PATH).href

// 注册一个内联的 resolve 钩子：只拦截 @deepseek-ai/schemastery 这一个包名
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === '@deepseek-ai/schemastery') return next(${JSON.stringify(target)}, ctx)
  return next(spec, ctx)
}`))
