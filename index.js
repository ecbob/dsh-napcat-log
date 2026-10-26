/**
 * dsh-napcat-log —— 把 NapCat（QQ 机器人框架）的**运行日志与登录二维码**桥进 DSH 的小插件
 *
 * 为什么需要它（本机 2026-10-26/27 实测出来的三条）：
 *   1) NapCat 是 GUI 进程，日志走 stdout。用 `start-console.bat` 那种"窗口版"起，日志就只在那个控制台里，
 *      agent 完全看不见；只有"重定向版"（`start-log.bat`）才会长出 `logs/napcat-out.txt` 这份可读文件。
 *   2) 那份文件被 NapCat 自己的重定向句柄占着：读它必须允许共享读写（本插件用 fs.readFile，实测读得到），
 *      而且**进程活着时删不掉**（想归档就先 stop）。
 *   3) 从"输出被捕获"的 shell 里 `cmd /c` 调启动脚本会被一路拖到 NapCat 退出（本机实测 **458.27 秒**），
 *      而且启动器若是调用方的子进程，**杀调用方会连带端掉 NapCat 整棵树**（本机撞过一次）。
 *      所以本插件起进程一律 `stdio:'ignore' + detached + unref` ⇒ 调用立刻返回、NapCat 不挂在调用方底下。
 *
 * 只 import node: 内置（fs/path/os/net/child_process），零运行时依赖，不起定时器、不开 webServer 路由、
 * 不加客户端分区（形态是"工具 + 一份说明书"），也不会自己给 QQ 发任何消息 —— 它只读文件、只起停进程。
 *
 * 家目录（全在这一个目录，删掉即彻底回滚）：
 *   $DSH_HOME/dsh-napcat-log/
 *     config.json      运行时配置（用的时候现读，优先于 patch 里的 config）
 *     status.json      状态快照（挂载即写一份、每次 status 再刷一份；判现场不依赖 HTTP）
 *     napcat-log.log   本插件自己的日志（记录每次 start/stop/restart 实际发了哪条命令）
 *     skills/napcat-log.md  使用者写的覆盖版说明书（同名即顶掉包内那份）
 *
 * NapCat 那边装在哪里**不写死**：按 `config.napcatDir` → 环境变量 `NAPCAT_DIR` → 常见位置探测（当前目录、
 * 家目录、以及它们上一级里名字像 NapCatQQ 的目录）这个顺序找，status 会回报"这次用的是哪条、怎么钉死"。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import cp from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-napcat-log'
/** 硬注入：这两样在本 profile 里必然存在（工具注册 / skill 注册表） */
export const inject = ['tools', 'skills']

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')) } catch { return { name: 'dsh-napcat-log', version: '0.0.0' } } })()
const MODES = ['log', 'console']
/** 一张 NapCat 登录码大约活 120 秒（本机实测每 120 秒换一张：`Login Error, ErrType: 1 ErrCode: 3` 就是没人扫） */
export const QR_TTL_SEC = 120

export const DEFAULTS = {
  napcatDir: '', webuiHost: '127.0.0.1', webuiPort: 6099, defaultMode: 'log',
  maxBytes: 200000, startProbeMs: 6000, stopWaitMs: 4000, probeMs: 900, snapshotName: 'qrcode-latest.png', logLevel: 'info'
}

/** 把任意来源的配置夹成可用值（数字夹范围、模式白名单、目录去尾斜杠）。导出给离线自检用。 */
export function __coerce(raw) {
  const c = { ...DEFAULTS }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const num = (v, lo, hi, dflt) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt }
  const dir = (v) => String(v ?? '').trim().replace(/[\\/]+$/, '')
  return {
    napcatDir: dir(src.napcatDir),
    webuiHost: String(src.webuiHost || c.webuiHost).trim() || c.webuiHost,
    webuiPort: num(src.webuiPort, 1, 65535, c.webuiPort),
    defaultMode: MODES.includes(String(src.defaultMode)) ? String(src.defaultMode) : c.defaultMode,
    maxBytes: num(src.maxBytes, 2000, 2000000, c.maxBytes),
    startProbeMs: num(src.startProbeMs, 0, 60000, c.startProbeMs),
    stopWaitMs: num(src.stopWaitMs, 0, 30000, c.stopWaitMs),
    probeMs: num(src.probeMs, 100, 5000, c.probeMs),
    snapshotName: dir(src.snapshotName).replace(/\\/g, '/') || c.snapshotName,
    logLevel: ['quiet', 'info', 'debug'].includes(String(src.logLevel)) ? String(src.logLevel) : c.logLevel
  }
}

/**
 * 找 NapCat 装在哪：① 显式配置 ② 环境变量 NAPCAT_DIR ③ 探测（cwd、家目录、以及它们上一级里名字像 NapCatQQ 的目录）。
 * 判"是真 NapCat 目录"的标准：里面有一层 `NapCat.<数字>.Shell`。找不到回 { dir:'', how:'not-found', tried }。
 * env / cwd / homeDir 都可注入，方便离线自检。
 */
export function __resolveNapcatDir(explicit, env, cwd, homeDir, candidatesExtra = []) {
  const looksLikeNapCat = (p) => { try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((n) => /^NapCat\.\d+\.Shell$/i.test(n)) } catch { return false } }
  const tried = []
  const take = (p, how) => { if (!p) return null; tried.push(p); return looksLikeNapCat(p) ? { dir: p, how } : null }
  const e = env && typeof env === 'object' ? env : {}
  let hit = take(String(explicit || '').trim() || undefined, 'config.napcatDir')
    || take(String(e.NAPCAT_DIR || '').trim() || undefined, '环境变量 NAPCAT_DIR')
  if (!hit) {
    const roots = [cwd, homeDir, ...candidatesExtra].filter(Boolean)
    const seen = new Set()
    for (const r of roots) {
      for (const up of [r, path.dirname(r)]) {
        const cand = path.join(up, 'NapCatQQ')
        if (seen.has(cand)) continue
        seen.add(cand)
        hit = take(cand, '探测（名字像 NapCatQQ 的目录）')
        if (hit) break
      }
      if (hit) break
    }
  }
  return hit ? { ...hit, tried } : { dir: '', how: 'not-found', tried }
}

/** 从 NapCat 根目录把各个"要看的东西"的路径都算出来（版本号不写死，靠 versions/ 里现找）。 */
export function __probeLayout(root) {
  const out = { root, shellDir: '', versionsDir: '', napcatAppDir: '', configDir: '', webuiJson: '', qrSrc: '', logsDir: '', logFile: '', errFile: '', snapshot: '', bats: {}, versionHint: '' }
  if (!root) return out
  const join = (...p) => path.join(root, ...p)
  out.logsDir = join('logs')
  out.logFile = path.join(out.logsDir, 'napcat-out.txt')
  out.errFile = path.join(out.logsDir, 'napcat-err.txt')
  out.snapshot = path.join(out.logsDir, 'qrcode-latest.png')
  for (const n of ['start-log.bat', 'start-console.bat', 'stop.bat']) out.bats[n] = { path: join(n), exists: fs.existsSync(join(n)) }
  out.bats['napcat.bat'] = { path: join('napcat.bat'), exists: fs.existsSync(join('napcat.bat')) }   // 根上如果有人自己放过一只
  let shell = ''
  try { shell = fs.readdirSync(root).find((n) => /^NapCat\.\d+\.Shell$/i.test(n)) || '' } catch { /* 目录读不动就算了 */ }
  out.shellDir = shell ? join(shell) : ''
  if (!out.shellDir) return out
  const officialBat = path.join(out.shellDir, 'napcat.bat')
  out.bats['<Shell>/napcat.bat'] = { path: officialBat, exists: fs.existsSync(officialBat), hint: '官方 Shell 目录里那只：末尾有 pause，脚本化调用会被它吊住；两种模式的日志都不落文件（除非它自己重定向）' }
  let ver = ''
  try {
    const vs = path.join(out.shellDir, 'versions')
    if (fs.existsSync(vs)) { const list = fs.readdirSync(vs).filter((n) => fs.statSync(path.join(vs, n)).isDirectory()); ver = list.sort().pop() || '' }
    if (ver) out.versionsDir = path.join(vs, ver)
  } catch { /* 同上 */ }
  out.versionHint = ver
  if (!out.versionsDir) return out
  out.napcatAppDir = path.join(out.versionsDir, 'resources', 'app', 'napcat')
  out.configDir = path.join(out.napcatAppDir, 'config')
  out.webuiJson = path.join(out.configDir, 'webui.json')
  out.qrSrc = path.join(out.napcatAppDir, 'cache', 'qrcode.png')
  return out
}

/** 尾读 + 解码：`auto` 先按 UTF-8 解、出现替换符再换 GBK 并回报用了哪种；**显式指定编码就不换**（人要的是那份原文，出现替换符也照实回报 hasReplacement）。 */
export function __readTextTail(file, maxBytes, wantEncoding) {
  const grab = (buf) => {
    const dec = (enc) => { try { return new TextDecoder(enc).decode(buf) } catch { return null } }
    const tried = []
    const order = wantEncoding === 'gbk' ? ['gbk'] : wantEncoding === 'utf8' ? ['utf-8'] : ['utf-8', 'gbk']
    let last = null
    for (const enc of order) {
      const t = dec(enc)
      if (t == null) { tried.push(enc + '（本机 ICU 不支持这种编码）'); continue }
      const has = t.includes('\uFFFD')
      last = last ?? { text: t, encoding: enc, hasReplacement: has, tried, fellBack: enc !== order[0] }
      if (!has) return { text: t, encoding: enc, hasReplacement: false, tried, fellBack: enc !== order[0] }
      if (order.length === 1) return { text: t, encoding: enc + '（有替换符）', hasReplacement: true, tried, fellBack: false }
      tried.push(enc + '（出现替换符，换下一种再试）')
    }
    return last ?? { text: '', encoding: 'none', hasReplacement: false, tried, fellBack: false }
  }
  let size = 0
  try { size = fs.statSync(file).size } catch (e) { return { ok: false, code: e?.code || 'stat_failed', error: String(e?.message || e) } }
  const cap = Math.max(2000, Math.min(Number(maxBytes) || DEFAULTS.maxBytes, 2000000))
  const len = Math.min(size, cap)
  if (len === 0) return { ok: true, text: '', encoding: 'utf-8', bytes: 0, size, cap, fromEnd: 0, fellBack: false, tried: [] }
  const buf = Buffer.alloc(len)
  let fd = null
  try {
    fd = fs.openSync(file, 'r')                                  // Windows 上 libuv 默认带 FILE_SHARE_READ|WRITE ⇒ 别人正占着也读得到
    const read = fs.readSync(fd, buf, 0, len, size - len)
    return { ok: true, ...grab(buf.subarray(0, read)), size, cap, bytes: read, fromEnd: size - len, truncated: size > len }
  } catch (e) {
    return { ok: false, code: e?.code || 'read_failed', error: String(e?.message || e), size, cap }
  } finally { if (fd != null) { try { fs.closeSync(fd) } catch { /* 已经关了 */ } } }
}

/** 行筛选：先剥掉 ANSI 颜色控制码（NapCat 用 chalk 上色，本机实测日志里全是 \u001b[32m 这类码，留着会把 filter 的正则和给人看的文本一起弄脏）；raw=false 时压掉二维码 ASCII 框线（NapCat 用的是 █▄▀ 三种块字符）并把连续空行压成一行；filter 能编成正则就按正则、不能就当子串；sinceMin 按行首时间戳筛。 */
export function __filterLines(text, { filter, raw, lines, sinceMin, now } = {}) {
  const ansi = /\u001b\[[0-9;]*[A-Za-z]/g
  const hasAnsi = /\u001b\[[0-9;]*[A-Za-z]/          // 不带 g 的那份用来数（带 g 的 .test 会挪 lastIndex，数出来会跳）
  const all = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
  const strippedAnsiLines = all.reduce((n, l) => n + (hasAnsi.test(l) ? 1 : 0), 0)
  const clean = strippedAnsiLines ? all.map((l) => l.replace(ansi, '')) : all
  let keep = raw === true ? clean.slice() : clean.filter((l) => !(/[█▄▀]/.test(l) && /^[\s█▄▀]*$/.test(l)))
  let droppedShape = clean.length - keep.length
  if (raw !== true) {   // 连续空行压成一行：NapCat 每轮换码都甩一串空行，全留着会把有用的行挤出去
    const sq = []
    let prevBlank = false
    for (const l of keep) { const b = l.trim() === ''; if (b && prevBlank) continue; sq.push(l); prevBlank = b }
    droppedShape += keep.length - sq.length
    keep = sq
  }
  let mode = 'none'
  if (filter != null && String(filter).trim() !== '') {
    const f = String(filter)
    let re = null
    try { re = new RegExp(f, 'i') } catch { re = null }
    mode = re ? 'regex' : 'contains'
    keep = re ? keep.filter((l) => re.test(l)) : keep.filter((l) => l.toLowerCase().includes(f.toLowerCase()))
  }
  if (Number.isFinite(Number(sinceMin)) && Number(sinceMin) > 0) {
    const ref = now instanceof Date ? now : new Date()
    const cutoff = ref.getTime() - Number(sinceMin) * 60000
    mode = mode === 'none' ? 'sinceMin' : mode + '+sinceMin'
    keep = keep.filter((l) => { const t = __lineTime(l, ref); return t != null && t >= cutoff })
  }
  const n = Math.max(1, Math.min(2000, Number(lines) || 60))
  const out = keep.slice(-n)
  return { text: out.join('\n'), count: out.length, scanned: clean.length, droppedBoxOrBlank: droppedShape, strippedAnsiLines, filterMode: mode, capped: keep.length > out.length }
}

/** 解 NapCat 日志行首的 `10-27 06:47:51`（没有年份、毫秒都不给）；拿当前时间补年份，补出来是未来就退一年（跨年时会发生）。 */
export function __lineTime(line, now) {
  const m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(line ?? ''))
  if (!m) return null
  const ref = now instanceof Date ? now : new Date()
  const t = Date.parse(ref.getFullYear() + '-' + m[1] + '-' + m[2] + 'T' + m[3] + ':' + m[4] + ':' + m[5])
  if (Number.isNaN(t)) return null
  if (t - ref.getTime() > 31 * 86400000) return t - 365 * 86400000            // 上一年
  if (ref.getTime() - t > 335 * 86400000) return t + 365 * 86400000           // 下一年（少见）
  return t
}

/** 端口通不通（net.connect，超时即当不通）。 */
export function __portOpen(host, port, timeoutMs = DEFAULTS.probeMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host: String(host || '127.0.0.1'), port: Number(port) || 6099 })
    let done = false
    const fin = (v) => { if (done) return; done = true; try { s.destroy() } catch { /* 已经关了 */ } resolve(v) }
    s.setTimeout(Math.max(100, Math.min(5000, Number(timeoutMs) || DEFAULTS.probeMs)))
    s.once('connect', () => fin(true))
    s.once('timeout', () => fin(false))
    s.once('error', () => fin(false))
  })
}

export function __qrTiming(mtimeMs, now) {
  const t = Number(mtimeMs)
  if (!Number.isFinite(t)) return { exists: false }
  const ref = now instanceof Date ? now : new Date()
  const ageSec = Math.max(0, Math.round((ref.getTime() - t) / 1000))
  return { exists: true, mtime: new Date(t).toISOString(), ageSec, expiresAt: new Date(t + QR_TTL_SEC * 1000).toISOString(), expiresInSec: Math.max(0, QR_TTL_SEC - ageSec), expired: ageSec > QR_TTL_SEC, ttlSec: QR_TTL_SEC }
}

/** 工具返回值必须是无损 JSON：NaN/Infinity 会变含义、BigInt 直接抛、undefined 会变 null ⇒ 统一先清一遍。 */
export function __lossless(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'bigint') return String(v)
  if (Array.isArray(v)) return v.map(__lossless)
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { if (x === undefined) continue; o[k] = __lossless(x) } return o }
  return v === undefined ? null : v
}

/** 工具结果里的图片是附件引用（{type:'image', attachment: ref}），字节先进宿主的 attachments 服务。 */
export function __renderWithImages(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
  const { image, images, ...rest } = src
  const parts = [{ type: 'text', text: JSON.stringify(rest, null, 2) }]
  const refs = [...(image ? [image] : []), ...(Array.isArray(images) ? images : [])]
  for (const ref of refs) parts.push({ type: 'image', attachment: ref })
  return parts
}

export async function __attachImages(get, exec, images) {
  const grab = (k) => { try { return get?.(k) } catch { return null } }
  const attachments = grab('attachments')
  if (!attachments?.saveImages) return { ok: false, reason: 'no_attachments', hint: '宿主 attachments 服务不可用 ⇒ 这次只回文件路径' }
  const llm = grab('llm')
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  if (llm?.resolveModelInfo) {
    try {
      const m = (await llm.resolveModelInfo(provider, model, exec?.signal))?.inputModalities
      if (Array.isArray(m) && !m.includes('image')) return { ok: false, reason: 'model_no_image', hint: '当前模型 ' + provider + '/' + model + ' 不接图片输入 ⇒ 这次只回路径，图以卡片给你扫' }
    } catch { /* 探针失败就当能发 */ }
  }
  try { return { ok: true, refs: await attachments.saveImages(images.map((i) => ({ data: i.buffer, mediaType: i.mediaType }))) } }
  catch (e) { return { ok: false, reason: 'save_failed', hint: '存图片附件失败：' + String(e?.message || e) } }
}

/**
 * 起/停 NapCat 的唯一正道：**脱管**。`stdio:'ignore' + detached:true + unref()` ⇒
 * ① 调用立刻返回（不会像从被捕获输出的 shell 里调那样等 458 秒）；② NapCat 不挂在本插件/会话底下，
 * 宿主重启或会话结束都不会顺手把它带走。窗口版给 windowsHide:false 让控制台可见。
 */
export function __spawnDetached(cmd, args, opts = {}) {
  const child = cp.spawn(cmd, args, { cwd: opts.cwd || undefined, stdio: 'ignore', detached: true, windowsHide: opts.mode !== 'console' })
  if (child?.unref) child.unref()
  return { pid: child?.pid ?? null, command: [cmd, ...args].join(' '), mode: opts.mode === 'console' ? 'console' : 'log' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
async function waitPort(host, port, wantOpen, budgetMs) {
  const t0 = Date.now()
  for (;;) {
    const open = await __portOpen(host, port, 900)
    if (open === !!wantOpen) return { open, waitedMs: Date.now() - t0 }
    if (Date.now() - t0 >= budgetMs) return { open, waitedMs: Date.now() - t0 }
    await sleep(300)
  }
}

export function apply(ctx, config = {}) {
  const cfgBase = __coerce(config)
  const home = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-napcat-log')
  const logFile = path.join(home, 'napcat-log.log')
  const statusFile = path.join(home, 'status.json')
  try { fs.mkdirSync(home, { recursive: true }) } catch { /* 家目录建不上也别拦挂载 */ }
  const liveCfg = () => { try { return __coerce({ ...cfgBase, ...JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) }) } catch { return cfgBase } }
  const liveVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version } catch { return PKG.version } }
  const log = (msg) => { try { fs.appendFileSync(logFile, new Date().toISOString() + '  ' + msg + '\n', 'utf8') } catch { /* 自己的日志写不上也别炸 */ } }

  // 布局与状态：每次现算（NapCat 版本目录、日志文件、二维码、webui.json 都可能变），不缓存 ⇒ 换版本/挪目录不用重启
  const layout = (c) => {
    const r = __resolveNapcatDir(c.napcatDir, process.env, process.cwd(), os.homedir())
    const L = __probeLayout(r.dir); L.dir = r.dir          // 给 doStart/doStop 用：它们要按根目录判"该杀谁"
    return { ...r, L }
  }
  const webuiInfo = (L, c) => {
    const out = { host: c.webuiHost, port: c.webuiPort, token: '', source: 'config 默认值', autoLoginAccount: '' }
    try {
      const j = JSON.parse(fs.readFileSync(L.webuiJson, 'utf8'))
      out.token = String(j.token || '')
      out.port = Number(j.port) || c.webuiPort
      out.host = String(j.host || c.webuiHost)
      out.autoLoginAccount = String(j.autoLoginAccount || '')
      out.source = 'NapCat 自己的 config/webui.json（权威，不是从日志猜的）'
    } catch { /* 读不到就用配置值，并在 status 里说明来源 */ }
    const h = out.host === '::' || out.host === '0.0.0.0' || out.host === '*' ? '127.0.0.1' : out.host
    out.url = 'http://' + h + ':' + out.port + '/webui' + (out.token ? '?token=' + out.token : '')
    out.probeHost = h
    return out
  }
  const qrInfo = (L, c, now) => {
    const o = { src: L.qrSrc, snapshot: path.join(L.logsDir, c.snapshotName) }
    try { const st = fs.statSync(L.qrSrc); Object.assign(o, __qrTiming(st.mtimeMs, now), { bytes: st.size }) } catch (e) { o.exists = false; o.why = String(e?.code || e) }
    try { const st = fs.statSync(o.snapshot); o.snapshotAgeSec = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000)) } catch { o.snapshotExists = false }
    return o
  }
  const statusBody = () => {
    const c = liveCfg(), { dir, how, tried, L } = layout(c), now = new Date()
    const w = webuiInfo(L, c), q = qrInfo(L, c, now)
    let logStat = null
    try { const st = fs.statSync(L.logFile); logStat = { bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), ageSec: Math.max(0, Math.round((now - st.mtime) / 1000)) } } catch (e) { logStat = { missing: true, why: String(e?.code || e) } }
    return {
      ok: true, plugin: PKG.name, version: liveVersion(), home,
      napcat: { dir, foundBy: how, tried, shellDir: L.shellDir, versionHint: L.versionHint, napcatAppDir: L.napcatAppDir, logsDir: L.logsDir, logFile: L.logFile, errFile: L.errFile, webuiConfig: L.webuiJson, qrcodeSource: L.qrSrc, launchers: L.bats },
      webui: w, qrcode: q, logFileStatus: logStat,
      statusFile, configFile: path.join(home, 'config.json'), ownLogFile: logFile, config: c
    }
  }
  const writeStatusSnapshot = () => {
    const body = { ...statusBody(), at: new Date().toISOString() }
    try { fs.writeFileSync(statusFile + '.tmp', JSON.stringify(__lossless(body), null, 2) + '\n', 'utf8'); fs.renameSync(statusFile + '.tmp', statusFile) } catch (e) { log('⚠️ status.json 没写上：' + String(e?.code || e?.message || e).slice(0, 160)) }
    return body
  }

  // ───────────────────────── 工具（就这一只） ─────────────────────────
  const outObj = () => ({ type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, message: { type: 'string' } } })
  const defineTool = (options) => {
    const chk = (s, w) => { if (!s || typeof s !== 'object') return; if (s.type === 'object' && s.additionalProperties === undefined) throw new Error(`defineTool(${options.name}): ${w} 是 object 却没写 additionalProperties`); for (const [k, v] of Object.entries(s.properties || {})) chk(v, `${w}.properties.${k}`) }
    chk(options.parameters, 'parameters'); chk(options.output?.schema, 'output.schema')
    return options
  }
  const sanitize = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node
    const out = { ...node }
    if (out.type !== 'object') { delete out.required; delete out.properties; delete out.additionalProperties; if (out.items) out.items = sanitize(out.items); return out }
    const props = {}, req = Array.isArray(out.required) ? [...out.required] : []
    for (const [k, v] of Object.entries(out.properties || {})) {
      const child = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : { type: 'string', description: String(v ?? '') }
      if (child.required === true) { req.push(k); delete child.required } else if ('required' in child) delete child.required
      props[k] = sanitize(child)
    }
    out.properties = props
    const uniq = [...new Set(req)]
    if (uniq.length) out.required = uniq; else delete out.required
    if (out.additionalProperties === undefined) out.additionalProperties = true
    return out
  }
  const str = (description, required = false) => ({ type: 'string', ...(required ? { required: true } : {}), description })
  const toolSpec = {
    name: 'napcat_log',
    description: '桥接 NapCat（QQ 机器人框架）的运行日志与登录二维码。action=status（在不在跑、哪种模式、WebUI 地址与 token、当前码还剩多少秒、装在哪、怎么钉死）| read（尾读 logs/napcat-out.txt，可 filter/sinceMin/编码）| qr（把当前登录码快照成 logs/qrcode-latest.png 并当图片附件回会话）| start|restart|stop（脱管起停：调用立刻返回，不挂在调用方底下；mode=log 走重定向、mode=console 开可见窗口）。日志只有"重定向模式"才会写进文件；窗口模式的输出只在它自己的控制台里。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: str('status | read | qr | start | stop | restart', true),
        mode: str('start/restart 用：log（默认，重定向进 logs/napcat-out.txt）或 console（开一个可见控制台，日志不进文件）。'),
        lines: { type: 'number', description: 'read：回最后多少行（1-2000，默认 60）' },
        filter: str('read：行过滤。能编成正则就按正则（不区分大小写），编不成就当子串包含。'),
        sinceMin: { type: 'number', description: 'read：只保留行首时间戳在最近 N 分钟内的行（按 NapCat 的 `MM-DD HH:MM:SS` 前缀解，年份由当前时间补）' },
        encoding: str('read：utf8 | gbk | auto（默认 auto：先 UTF-8，出现替换符再换 GBK，并回报用了哪种）'),
        raw: { type: 'boolean', description: 'read：true 时连二维码 ASCII 框线与连续空行也留下（ANSI 颜色码无论如何都剥掉，那是控制码不是内容）' },
        save: { type: 'boolean', description: 'qr：false 时只报不落盘（默认 true：复制成 logs/<snapshotName>）' },
        waitMs: { type: 'number', description: 'start/stop：起停后最多再等这么久看端口变化（起默认 6000、停默认 4000；给 0 就纯脱管立刻回）' },
        quick: str('start/restart 用：要快速登录的 QQ 号（原样转给 NapCatWinBootMain.exe）。前提是这台机器上这个号已成功登录过一次、会话还在 —— 日志里"可用于快速登录 of QQ："那一段列的就是可用号。')
      }
    },
    output: { schema: outObj(), render: (a, v) => __renderWithImages(v) }
  }

  const doRead = (a, c, L) => {
    if (!L.logFile) return { ok: false, code: 'no_dir', message: '找不到 NapCat 目录，没法读日志。用 config.napcatDir 钉死（或设环境变量 NAPCAT_DIR）。' }
    const r = __readTextTail(L.logFile, c.maxBytes, a.encoding === 'gbk' ? 'gbk' : a.encoding === 'utf8' ? 'utf8' : 'auto')
    if (!r.ok) return { ok: false, code: r.code, message: '读日志失败：' + r.error + '（文件：' + L.logFile + '）', hint: r.code === 'ENOENT' ? '这份文件只有"重定向模式"起时才存在；窗口模式的日志在它自己的控制台窗口里。想桥接就用 start(mode:"log")。' : undefined }
    const f = __filterLines(r.text, { filter: a.filter, raw: a.raw === true, lines: a.lines, sinceMin: a.sinceMin, now: new Date() })
    return {
      ok: true, action: 'read', file: L.logFile, bytesRead: r.bytes, fileSize: r.size, encodingUsed: r.encoding, fellBack: r.fellBack === true, triedEncodings: r.tried,
      truncatedTail: r.truncated === true, droppedBoxOrBlankLines: f.droppedBoxOrBlank, strippedAnsiLines: f.strippedAnsiLines, filterMode: f.filterMode, cappedAtLines: f.capped, linesReturned: f.count,
      text: f.text, message: f.count ? '' : '（筛选后没有行；' + (f.scanned ? '原文件有 ' + f.scanned + ' 行' : '文件是空的') + '）'
    }
  }
  const doStatus = async (c, L, exec) => {
    const body = statusBody()
    const w = body.webui
    const listening = await __portOpen(w.probeHost, w.port, c.probeMs)
    const lastLines = (() => { const r = __readTextTail(L.logFile, 8000, 'auto'); if (!r.ok) return []; return __filterLines(r.text, { raw: false, lines: 3, now: new Date() }).text.split('\n').filter(Boolean) })()
    const q = body.qrcode
    const modeGuess = !listening ? 'stopped（端口 ' + w.port + ' 不通）'
      : (body.logFileStatus?.ageSec != null && body.logFileStatus.ageSec <= QR_TTL_SEC + 20 ? 'log（日志文件还在长 ⇒ 桥接可用）' : '端口通着但日志文件没在长 ⇒ 多半是窗口模式在跑（日志不进文件），或实例正闲着')
    const out = {
      ...body, running: listening, port: w.port, portOpen: listening, modeGuess,
      lastLogLines: lastLines,
      message: (listening ? '在跑。' : '没在跑。') + ' ' + modeGuess + (q.exists ? ' 当前登录码已生成 ' + q.ageSec + ' 秒（约 ' + q.expiresInSec + ' 秒后过期）' + (q.expired ? '，已过期：它每 ' + QR_TTL_SEC + ' 秒自己换一张' : '') : ' 还没有二维码文件'),
      notes: [
        '判"在不在跑"用的是 TCP 连 ' + w.probeHost + ':' + w.port + '（不靠进程表、不靠 HTTP 鉴权）。',
        'token 来源：' + w.source + '。',
        '目录是' + (String(body.napcat.foundBy).startsWith('config') ? '按 config.napcatDir 用的' : '靠 ' + body.napcat.foundBy + ' 找到的（想钉死就写 config.napcatDir）') + '。',
        '想开始桥接：先 start（mode 给 log）。窗口模式的日志不进文件，插件读不到。'
      ]
    }
    if (q.exists) {
      const img = await attachQr(c, L, exec, out.qrcode)
      if (img) out.image = img
    }
    return out
  }
  const attachQr = async (c, L, exec, q) => {
    try {
      const buf = fs.readFileSync(L.qrSrc)
      const att = await __attachImages((k) => ctx.get?.(k), exec, [{ buffer: buf, mediaType: 'image/png' }])
      if (att.ok && att.refs?.[0]) return att.refs[0]
      log('二维码图片没能作为附件回（' + (att.reason || '未知') + '）：' + (att.hint || ''))
      return null
    } catch (e) { log('读二维码失败：' + String(e?.code || e?.message || e).slice(0, 120)); return null }
  }
  const doQr = async (a, c, L, exec) => {
    const now = new Date()
    if (!L.qrSrc) return { ok: false, code: 'no_dir', message: '找不到 NapCat 目录/版本目录，算不出二维码路径。' }
    let st = null
    try { st = fs.statSync(L.qrSrc) } catch (e) { return { ok: false, code: String(e?.code || e), message: '还没有二维码文件（' + L.qrSrc + '）—— 通常是没在跑，或还没走到出码那步。用 start(mode:"log") 起一份再看。' } }
    const snap = path.join(L.logsDir, c.snapshotName)
    let saved = false, saveErr = ''
    if (a.save !== false) {
      try { fs.mkdirSync(L.logsDir, { recursive: true }); fs.copyFileSync(L.qrSrc, snap); saved = true } catch (e) { saveErr = String(e?.code || e?.message || e).slice(0, 120) }
    }
    const q = { ...__qrTiming(st.mtimeMs, now), bytes: st.size, src: L.qrSrc }
    const tail = __readTextTail(L.logFile, 12000, 'auto')
    const urlLine = tail.ok ? (tail.text.split(/\r?\n/).filter((l) => /txz\.qq\.com|gitee|QRcode|二维码解码/.test(l)).pop() || '') : ''
    const out = {
      ok: true, action: 'qr', qrcode: q, snapshotPath: saved ? snap : '', snapshotSaved: saved, snapshotError: saveErr,
      decodingUrlLine: urlLine ? urlLine.trim() : '', expiredNote: q.expired ? '这张已经过了 ' + q.ageSec + ' 秒（超过 ' + QR_TTL_SEC + ' 秒），NapCat 每 ' + QR_TTL_SEC + ' 秒换一张：要么直接看 WebUI（' + (webuiInfo(L, c).url) + '，它会刷新）要么 qr 再问一次拿新的' : '还剩约 ' + q.expiresInSec + ' 秒，抓紧扫',
      webui: webuiInfo(L, c).url,
      message: '当前码：生成于 ' + q.mtime + '，' + (q.expired ? '已过期' : '剩 ' + q.expiresInSec + ' 秒') + (saved ? '；快照已写到 ' + snap : saveErr ? '；快照没写上（' + saveErr + '）' : '；这次没落盘（save:false）')
    }
    const img = await attachQr(c, L, exec, q)
    if (img) out.image = img
    return out
  }
  const pickLauncher = (mode, L) => {
    const want = mode === 'console' ? 'start-console.bat' : 'start-log.bat'
    const hit = L.bats[want]?.exists ? L.bats[want].path : ''
    if (hit) return { cmd: hit, kind: 'bat' }
    if (!L.shellDir) return { cmd: '', kind: 'missing' }
    return { cmd: ' NapCatWinBootMain.exe', kind: 'fallback', shell: L.shellDir }
  }
  const doStart = async (a, c, L, verb) => {
    if (!L.dir) return { ok: false, code: 'no_dir', message: '找不到 NapCat 装在哪。先写 config.napcatDir（或设 NAPCAT_DIR），再来。' }
    const mode = MODES.includes(String(a.mode)) ? String(a.mode) : c.defaultMode
    const w = webuiInfo(L, c)
    const already = await __portOpen(w.probeHost, w.port, c.probeMs)
    let stopped = null
    if (verb === 'restart' && already) {
      stopped = await doStop(c, L, w, a.waitMs)
      if (!stopped.portClosed) return { ok: false, code: 'still_running', message: 'restart 想先停但没停掉（端口还通着）；先手动处理再试。', stopReport: stopped }
    }
    if (verb === 'start' && already) {
      return { ok: true, action: 'start', alreadyRunning: true, portOpen: true, mode, quickLogin: '', webui: w.url, message: '已经在跑了（端口 ' + w.port + ' 通着），这次没再起一份 —— 同一目录起两份 QQ 会互相顶掉（实测：后起的那一份把前一份顶成 Process exited.）。' + (String(a.quick ?? '').trim() ? ' 你要的快速登录没用上：先 stop 再 start(quick:"…")。' : '') }
    }
    const t0 = Date.now()
    const qraw = String(a.quick ?? '').trim()
    const quick = /^\d{5,12}$/.test(qraw) ? qraw : ''      // 形状不对就当没给（不拿任意字符串去拼命令行，免得给人当注入面）
    const launcher = pickLauncher(mode, L)
    const extra = quick ? ' ' + quick : ''
    let spawned
    if (launcher.kind === 'bat') spawned = __spawnDetached(process.env.ComSpec || 'cmd.exe', ['/c', '"' + launcher.cmd + '"' + extra], { cwd: L.dir, mode })
    else spawned = __spawnDetached(process.env.ComSpec || 'cmd.exe', ['/c', 'cd /d "' + L.shellDir + '" & NapCatWinBootMain.exe' + extra + (mode === 'log' ? ' > "' + L.logFile + '" 2> "' + L.errFile + '"' : '')], { cwd: L.shellDir, mode })
    log(verb + '（mode=' + mode + (quick ? ' 快速登录=' + quick : '') + '）脱管发出：' + spawned.command + ' pid=' + spawned.pid)
    const probeBudget = a.waitMs != null ? Math.max(0, Math.min(60000, Number(a.waitMs) || 0)) : (mode === 'log' ? c.startProbeMs : 0)
    const port = probeBudget > 0 ? await waitPort(w.probeHost, w.port, true, probeBudget) : { open: await __portOpen(w.probeHost, w.port, 400), waitedMs: 0 }
    const waitedMs = Date.now() - t0
    return {
      ok: true, action: verb, mode, quickLogin: quick, quickRejected: (qraw && !quick) ? qraw : '', commandUsed: launcher.kind === 'bat' ? launcher.cmd : '（没有 ' + (mode === 'console' ? 'start-console.bat' : 'start-log.bat') + '，退回直接起 NapCatWinBootMain.exe）',
      spawnedPid: spawned.pid, detached: true, portOpenAfter: port.open, waitedForPortMs: port.waitedMs, totalCallMs: waitedMs,
      logFile: mode === 'log' ? L.logFile : '', qrcodeSource: L.qrSrc, webui: w.url, stopReport: stopped || undefined,
      message: (port.open ? '起来了（端口 ' + w.port + ' 通着）' : '命令已脱管发出，但端口 ' + w.port + ' 还没通（' + waitedMs + 'ms 内）—— 首次起要解 QQ 与注入，慢是正常的，再问一次 status') + '；调用侧没被拖住：' + waitedMs + 'ms' + (mode === 'console' ? '；窗口模式的日志不进文件，只在它自己的控制台里' : '；日志在 ' + L.logFile) + (quick ? '；已把 ' + quick + ' 转给启动器做快速登录（会话还在就免扫码，不在就照旧出二维码，用 read 看登录那几行）' : '') + (qraw && !quick ? '；quick 值「' + qraw + '」不像 QQ 号（要 5-12 位数字），这次没转给它' : '')
    }
  }
  const doStop = async (c, L, w, waitMs) => {
    if (!L.dir) return { ok: false, code: 'no_dir', message: '找不到 NapCat 目录，不知道要停谁。' }
    const before = await __portOpen(w.probeHost, w.port, c.probeMs)
    const bat = L.bats['stop.bat']?.exists ? L.bats['stop.bat'].path : ''
    const cmd = bat ? bat : null
    const t0 = Date.now()
    let spawned
    if (cmd) spawned = __spawnDetached(process.env.ComSpec || 'cmd.exe', ['/c', cmd], { cwd: L.dir, mode: 'log' })
    else spawned = __spawnDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "$p=@(Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + L.dir.replace(/'/g, "''") + "*' }); $p | Stop-Process -Force -ErrorAction SilentlyContinue"], { cwd: L.dir, mode: 'log' })
    log('stop 脱管发出：' + spawned.command + ' pid=' + spawned.pid + '（' + (cmd ? '用 stop.bat：只杀本目录那份' : '没有 stop.bat，退回只按 Path 前缀杀本目录那份 QQ') + '）')
    const budget = waitMs != null ? Math.max(0, Math.min(30000, Number(waitMs) || 0)) : c.stopWaitMs
    const port = before && budget > 0 ? await waitPort(w.probeHost, w.port, false, budget) : { open: before, waitedMs: 0 }
    return {
      ok: true, action: 'stop', commandUsed: cmd || '（退回 powershell 按 Path 前缀杀）', spawnedPid: spawned.pid, detached: true,
      wasRunning: before, portClosed: !port.open, waitedForCloseMs: port.waitedMs, totalCallMs: Date.now() - t0,
      message: before ? (port.open ? '命令已发出，但端口 ' + w.port + ' 还通着（等了 ' + port.waitedMs + 'ms）—— 可能还有 QQ 进程没退干净，或用 status 再看' : '停了（端口 ' + w.port + ' 已释放，等了 ' + port.waitedMs + 'ms）') : '本来就没在跑（端口不通），没动任何东西',
      note: '只针对 ' + L.dir + ' 底下那份；别的目录的 QQ（例如装在别处的）不受影响。'
    }
  }

  const exec_tool = async (a, exec) => {
    const act = String(a?.action || 'status').toLowerCase()
    const c = liveCfg(), { dir, how, L } = layout(c)
    if (act === 'read') return doRead(a, c, L)
    if (act === 'qr') return doQr(a, c, L, exec)
    if (act === 'start') return doStart(a, c, L, 'start')
    if (act === 'restart') return doStart(a, c, L, 'restart')
    if (act === 'stop') { const w = webuiInfo(L, c); return doStop(c, L, w, a?.waitMs) }
    if (act === 'status') return doStatus(c, L, exec)
    return { ok: false, code: 'bad_action', message: 'action 只认 status/read/qr/start/stop/restart，收到的是 ' + JSON.stringify(a?.action) }
  }

  const parameters = sanitize(toolSpec.parameters)
  const output = { ...toolSpec.output, schema: sanitize(toolSpec.output.schema) }
  try { ctx.tools.register(defineTool({ ...toolSpec, parameters, output, execute: async (args, exec) => __lossless(await exec_tool(args, exec)) })); log('已注册工具 napcat_log') }
  catch (e) { log('⚠️ 工具注册失败：' + String(e?.message || e).slice(0, 300)) }

  // ───────────────────────── 一份说明书 ─────────────────────────
  const parseFront = (raw, where) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
    if (!m) throw new Error('dsh-napcat-log: ' + where + ' 没有 YAML frontmatter')
    const meta = {}; let key = null
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
      if (kv) { key = kv[1]; meta[key] = kv[2].trim().replace(/^['"]|['"]$/g, '') }
      else if (key && /^\s+\S/.test(line)) meta[key] += ' ' + line.trim()
    }
    if (!meta.description) throw new Error('dsh-napcat-log: ' + where + ' 缺 description')
    return { name: meta.name, description: meta.description, whenToUse: meta.whenToUse || undefined, content: raw.slice(m[0].length).trim() }
  }
  const SKILL_NAMES = ['napcat-log']
  const skillPath = (n) => { const over = path.join(home, 'skills', n + '.md'); return fs.existsSync(over) ? { file: over, from: 'home' } : { file: path.join(here, 'skills', n + '.md'), from: 'package' } }
  // 目录每次 list() 现扫（包内 + 家目录的并集，家目录那份赢）⇒ 新增/改名不必重启；正文每次 get() 现读 ⇒ 改正文当场生效。
  // 默认不起 fs.watch（本地模型下"零后台"优先）；要热更目录另加。
  const collectNames = () => {
    const names = new Set(SKILL_NAMES)
    for (const dir of [path.join(here, 'skills'), path.join(home, 'skills')]) {
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) names.add(path.basename(f, '.md')) } catch { /* 目录还没有 */ }
    }
    return [...names].sort()
  }
  const footer = (n) => '\n\n## 本插件的底座（dsh-napcat-log v' + liveVersion() + '）\n\n'
    + '**就一只工具**：`napcat_log`（status / read / qr / start / stop / restart），它不替你决定给 QQ 发任何东西。\n'
    + '**桥接口径**：只有"重定向模式"（`start` 默认那条）会长出 `logs/napcat-out.txt`；窗口模式的日志只在它自己的控制台里，本插件读不到。\n'
    + '**记忆在这儿**：家目录 ' + home + '（config.json 用的时候现读、status.json 挂载即写、napcat-log.log 记每次起停）；NapCat 那边当前用的是 ' + (layout(liveCfg()).dir || '（还没找到）') + '\n'
    + '**要改这份说明书**：编辑 ' + skillPath(n).file + '（家目录放同名文件就顶掉包内那份，升级不冲）。\n'
  const buildCandidates = () => {
    const out = []
    for (const n of collectNames()) {
      try {
        const { file, from } = skillPath(n)
        const s = parseFront(fs.readFileSync(file, 'utf8'), n)
        out.push({
          name: s.name || n,
          description: s.description,
          ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'dsh-napcat-log',
          source: from === 'home' ? 'override' : 'bundled',
          rank: 620,
          resourceBase: { kind: 'directory', path: path.dirname(file).split(path.sep).join('/') },
          locator: file,
          from
        })
      } catch (e) { log('⚠️ skill ' + n + ' 没进目录：' + String(e?.message || e).slice(0, 140)) }
    }
    return out
  }
  const offSkills = ctx.skills.registerProvider(() => ({
    name: 'dsh-napcat-log',
    list: () => Promise.resolve(buildCandidates().map(({ locator, from, ...rest }) => ({ ...rest }))),
    async get(candidate) {
      const { file } = skillPath(candidate.name)
      const s = parseFront(fs.readFileSync(file, 'utf8'), candidate.name + '.md')
      return { ...candidate, invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-napcat-log', content: s.content + footer(candidate.name) }
    },
    close: () => { /* 默认不起 fs.watch */ }
  }))
  ctx.effect(() => { if (typeof offSkills === 'function') offSkills() }, 'dsh-napcat-log: skills provider')

  writeStatusSnapshot()
  log('已挂载（家=' + home + '，工具 1 只，skill 1 份，NapCat 目录=' + (layout(liveCfg()).dir || '未找到') + '）')
}
