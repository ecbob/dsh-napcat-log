// dsh-napcat-log 的离线自检：不需要 NapCat 在跑、不需要宿主、不联网。
// 做法：在临时目录里造一棵"假 NapCat"（NapCat.<数字>.Shell + versions/<ver>/resources/app/napcat/{config,cache} + logs + 三个 .bat），
// 把 DSH_HOME 指到临时家目录，process.chdir 到临时根（让它靠"探测"这条规则找到假目录，顺带证明没写死本机路径），
// 再用假 ctx 跑完整条 apply()：工具注册形状、六个动作的行为、说明书目录与覆盖、起停的"脱管不许吊住调用方"。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import cp from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')
let pass = 0, fail = 0, skipped = 0
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('PASS  ' + label) } else { fail++; console.log('FAIL  ' + label + (extra !== undefined ? '  <<' + String(extra).slice(0, 320) + '>>' : '')) } }
const skip = (label, why) => { skipped++; console.log('SKIP  ' + label + '  (' + why + ')') }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-napcat-log-selftest-'))
const dshHome = path.join(tmp, 'dsh-home')
process.env.DSH_HOME = dshHome                        // 插件自己把家目录拼成 $DSH_HOME/dsh-napcat-log
const home = path.join(dshHome, 'dsh-napcat-log')     // 下面所有断言都按这份真家目录去查（别拿 DSH_HOME 当插件家目录）
fs.mkdirSync(dshHome, { recursive: true })
delete process.env.NAPCAT_DIR

/** 造一棵假 NapCat：root 下面一层 NapCat.52230.Shell，版本目录两个（要挑新那个） */
function makeNapcat(root, { bats = true, sleepBatMs = 0, webuiHost = '::', token = 'a800943cd602' } = {}) {
  const shell = path.join(root, 'NapCat.52230.Shell')
  const app = path.join(shell, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat')
  const old = path.join(shell, 'versions', '9.9.30-111', 'resources', 'app', 'napcat')
  for (const d of [app, old, path.join(app, 'config'), path.join(app, 'cache')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(app, 'config', 'webui.json'), JSON.stringify({ host: webuiHost, port: 6099, token, loginRate: 10, autoLoginAccount: '' }, null, 4), 'utf8')
  fs.writeFileSync(path.join(app, 'config', 'napcat.json'), JSON.stringify({ napcatName: 'napcat' }), 'utf8')
  fs.writeFileSync(path.join(shell, 'versions', '9.9.30-111', 'resources', 'app', 'napcat', 'napcat.mjs'), '// 旧版本目录（不该被挑中）\n', 'utf8')
  const logs = path.join(root, 'logs')
  fs.mkdirSync(logs, { recursive: true })
  fs.writeFileSync(path.join(logs, 'napcat-err.txt'), 'Usage: NapCatWinBootMain.exe <quickLogin>\n', 'utf8')
  if (bats) {
    const nap = (n) => '@echo off\r\nrem ' + n + '\r\n' + (sleepBatMs ? 'ping -n ' + Math.ceil(sleepBatMs / 1000 + 1) + ' 127.0.0.1 >nul\r\n' : 'exit /b 0\r\n')
    fs.writeFileSync(path.join(root, 'start-log.bat'), nap('start-log'), 'utf8')
    fs.writeFileSync(path.join(root, 'start-console.bat'), nap('start-console'), 'utf8')
    fs.writeFileSync(path.join(root, 'stop.bat'), nap('stop'), 'utf8')
    fs.writeFileSync(path.join(shell, 'napcat.bat'), '@echo off\r\nchcp 65001\r\n.\\NapCatWinBootMain.exe\r\npause\r\n', 'utf8')
  }
  return { root, shell, app, logs, qr: path.join(app, 'cache', 'qrcode.png') }
}

// 一份真 PNG 的字节（最小合法头 + IEND，只当"文件存在/大小"用，不解图）
const PNG_MIN = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d4948445200000009000000090802000000', 'hex'), Buffer.from('c4e299a9', 'hex'), Buffer.from('0000000a4944415478da63fcff3f030007060206', 'hex'), Buffer.from('0000000049454e44ae426082', 'hex')])
function writeQr(p, ageMs = 30000) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, PNG_MIN); const t = new Date(Date.now() - ageMs); fs.utimesSync(p, t, t); return p }

function pad2(n) { return String(n).padStart(2, '0') }
function napLogStamp(d) { return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) }

function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) }) }
function openServer(port) { return new Promise((res) => { const s = net.createServer((c) => c.end()); s.listen(port, '127.0.0.1', () => res(s)) }) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const M = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href)
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const src = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8')

/* ── 1. 插件身份与包形状 ── */
ok('导出的 name/inject 就是插件名 + 硬注入 tools/skills 两样（声明别的服务会让半个插件起不来）', M.name === 'dsh-napcat-log' && JSON.stringify(M.inject) === JSON.stringify(['tools', 'skills']), JSON.stringify({ name: M.name, inject: M.inject }))
ok('二维码寿命常量是 120 秒（本机实测每 120 秒换一张，说明书与回报都用它）', M.QR_TTL_SEC === 120, M.QR_TTL_SEC)
ok('package.json 没有客户端那半个（形态就是工具 + 说明书：不该有 exports["./client"] 与 dsh.client）', !pkg.exports['./client'] && !pkg.dsh.client, JSON.stringify({ exports: Object.keys(pkg.exports), dsh: Object.keys(pkg.dsh) }))
ok('files 白名单收全了跑得起来的东西（index.js / skills / scripts / cordis.patch.yml / README / LICENSE）', ['index.js', 'skills', 'scripts', 'cordis.patch.yml', 'README.md', 'LICENSE'].every((f) => pkg.files.includes(f)), JSON.stringify(pkg.files))
ok('描述讲的是现在的能力且提到"脱管"与六个动作里的关键词，不带改名/历史话', /napcat_log/.test(pkg.description) && /脱管/.test(pkg.description) && /零运行时依赖/.test(pkg.description) && !/原名|以前叫|改名/.test(pkg.description), pkg.description.slice(0, 60))

/* ── 2. 配置夹紧 ── */
const d0 = M.__coerce({})
ok('什么都不给时用内置默认（端口 6099、模式 log、尾读 200KB、探测 900ms）', d0.webuiPort === 6099 && d0.defaultMode === 'log' && d0.maxBytes === 200000 && d0.probeMs === 900 && d0.napcatDir === '', JSON.stringify(d0))
const c1 = M.__coerce({ webuiPort: 999999, maxBytes: 10, probeMs: 1, startProbeMs: -5, stopWaitMs: 'abc', defaultMode: '瞎写', logLevel: 'trace', napcatDir: 'D:/some/dir/NapCatQQ///', snapshotName: 'a\\b\\c.png' })
ok('越界与坏值全被夹住/回退，不会把插件搞崩（端口夹上限、负数归 0、非数字回默认、模式与日志级别走白名单）', c1.webuiPort === 65535 && c1.maxBytes === 2000 && c1.probeMs === 100 && c1.startProbeMs === 0 && c1.stopWaitMs === d0.stopWaitMs && c1.defaultMode === 'log' && c1.logLevel === 'info', JSON.stringify(c1))
ok('目录值去掉结尾斜杠（正斜杠反斜杠都剥），快照名里的反斜杠换成斜杠', c1.napcatDir === 'D:/some/dir/NapCatQQ' && !c1.snapshotName.includes('\\'), JSON.stringify({ dir: c1.napcatDir, snap: c1.snapshotName }))
ok('给非对象（数组 / null / 字符串）也不炸，全部回默认', ['x', null, ['a'], 42].every((v) => M.__coerce(v).webuiPort === 6099), '—')

/* ── 3. 找 NapCat 目录（不写死本机路径） ── */
const A = path.join(tmp, 'probeA'), B = path.join(tmp, 'probeB'), U = path.join(tmp, 'probeUp')
fs.mkdirSync(path.join(A, 'NapCatQQ', 'NapCat.1234.Shell'), { recursive: true })
fs.mkdirSync(path.join(B, 'NapCatQQ', 'NapCat.777.Shell'), { recursive: true })
fs.mkdirSync(path.join(U, 'NapCatQQ', 'NapCat.9.Shell'), { recursive: true })
fs.mkdirSync(path.join(U, 'deep', 'x'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'decoy'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'decoy', 'note.txt'), 'x', 'utf8')
fs.mkdirSync(path.join(tmp, 'lonely', 'a', 'b'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'lonely', 'c'), { recursive: true })
const r1 = M.__resolveNapcatDir(path.join(B, 'NapCatQQ'), { NAPCAT_DIR: path.join(A, 'NapCatQQ') }, path.join(tmp, 'nowhere'), tmp)
ok('config.napcatDir 优先级最高（哪怕环境变量指别处）', r1.dir === path.join(B, 'NapCatQQ') && r1.how === 'config.napcatDir', JSON.stringify(r1))
const r2 = M.__resolveNapcatDir(path.join(tmp, 'decoy'), { NAPCAT_DIR: path.join(A, 'NapCatQQ') }, path.join(tmp, 'nowhere'), tmp)
ok('配置给的目录不像 NapCat（里面没有 NapCat.<数字>.Shell 那一层）就不当真，退回下一档', r2.dir === path.join(A, 'NapCatQQ') && r2.how === '环境变量 NAPCAT_DIR', JSON.stringify(r2))
const r3 = M.__resolveNapcatDir('', { NAPCAT_DIR: path.join(tmp, 'decoy') }, path.join(B, 'anything'), tmp)
ok('环境变量也不像 NapCat 时退回探测当前目录（cwd 底下的 NapCatQQ 找得到）', r3.dir === path.join(B, 'NapCatQQ') && /探测/.test(r3.how), JSON.stringify(r3))
const r4 = M.__resolveNapcatDir('', {}, path.join(U, 'deep'), tmp)
ok('当前目录没有就往上一级看（<工作区>\\NapCatQQ 这种工程目录布局正是靠这条命中）', r4.dir === path.join(U, 'NapCatQQ'), JSON.stringify(r4))
const r5 = M.__resolveNapcatDir('', {}, path.join(tmp, 'lonely', 'a', 'b'), path.join(tmp, 'lonely', 'c'))
ok('哪条都不中时如实回 not-found 并把试过的路数报出来（不瞎猜一个继续跑）', r5.dir === '' && r5.how === 'not-found' && r5.tried.length >= 3, JSON.stringify(r5))
const rShape = (() => { const d = path.join(tmp, 'shape'); fs.mkdirSync(path.join(d, 'NapCat.xShell'), { recursive: true }); return M.__resolveNapcatDir(d, {}, d, d) })()
ok('判"真 NapCat"只认 NapCat.<数字>.Shell 这种形状（NapCat.xShell 不算、指到文件也不算）', rShape.dir === '' && M.__resolveNapcatDir(path.join(tmp, 'decoy', 'note.txt'), {}, tmp, tmp).dir === '', JSON.stringify({ shape: rShape.how }))

/* ── 4. 目录布局现算（版本目录不写死） ── */
const N = makeNapcat(path.join(tmp, 'NapCatQQ'))
const L = M.__probeLayout(N.root)
ok('从根目录算得出 shell / 版本目录 / napcat 应用目录 / 日志 / 二维码 / webui.json 各路径', L.shellDir === N.shell && L.napcatAppDir === N.app && L.logFile === path.join(N.logs, 'napcat-out.txt') && L.errFile === path.join(N.logs, 'napcat-err.txt') && L.qrSrc === N.qr && /webui\.json$/.test(L.webuiJson), JSON.stringify({ shell: L.shellDir, app: L.napcatAppDir, qr: L.qrSrc }))
ok('versions/ 里有好几个时挑名字最靠后的那个（NapCat 升版不用改插件）', L.versionHint === '9.9.33-52230' && L.versionsDir.endsWith('9.9.33-52230'), JSON.stringify({ v: L.versionHint, dir: L.versionsDir }))
ok('四只启动脚本的存在性都探出来（根上我自定的三只 + Shell 目录里官方那只 <Shell>/napcat.bat，并带"末尾有 pause 会吊住调用方"的提示）', L.bats['start-log.bat'].exists && L.bats['start-console.bat'].exists && L.bats['stop.bat'].exists && L.bats['<Shell>/napcat.bat'].exists && /pause/.test(L.bats['<Shell>/napcat.bat'].hint), JSON.stringify(Object.fromEntries(Object.entries(L.bats).map(([k, v]) => [k, v.exists]))))
ok('空根目录/不存在的根目录不炸，全回空串（__probeLayout 是被反复调的，不能抛）', (() => { const a = M.__probeLayout(''); const b = M.__probeLayout(path.join(tmp, '没有这个目录')); return a.shellDir === '' && a.qrSrc === '' && b.bats['stop.bat'].exists === false })(), '—')

/* ── 5. 尾读与编码 ── */
const bigLog = path.join(N.logs, 'napcat-out.txt')
const lines = []
for (let i = 1; i <= 200; i++) lines.push(napLogStamp(new Date()) + ' [info] 第 ' + i + ' 行 内容内容内容内容内容内容')
lines.push('█ █   █ █▀▄ ██   ▄▄   ▀   ▄▄▄▄█  ▄█')
lines.push('二维码解码URL: https://txz.qq.com/p?k=1HDYshFZhDn8fijEZJtl5-b-Y3TohD3Y&f=1600001604')
lines.push('10-27 07:12:5x Process exited.')
fs.writeFileSync(bigLog, lines.join('\n') + '\n', 'utf8')
const tAll = M.__readTextTail(bigLog, 400000, 'auto')
ok('整份读到时最后一行就是文件真末行、fromEnd=0、truncated=false', tAll.ok && tAll.text.trim().endsWith('Process exited.') && tAll.fromEnd === 0 && tAll.truncated === false, JSON.stringify({ tail: String(tAll.text).slice(-40), fromEnd: tAll.fromEnd }))
const tTail = M.__readTextTail(bigLog, 300, 'auto')
ok('限字节时从**文件尾部**往前取（不是从头截），并回报 truncated 与起始偏移（上限有个 2000 字节的地板，太小没意义）', tTail.ok && tTail.text.trim().endsWith('Process exited.') && tTail.truncated === true && tTail.fromEnd > 0 && tTail.bytes <= Math.max(2000, 300) && tTail.cap === 2000, JSON.stringify({ bytes: tTail.bytes, cap: tTail.cap, fromEnd: tTail.fromEnd }))
const tMiss = M.__readTextTail(path.join(N.logs, '压根没有.txt'), 1000, 'auto')
ok('文件不存在时回 code=ENOENT（调用方据此提示"窗口模式没有文件"），不是回一份空文本当成功', tMiss.ok === false && tMiss.code === 'ENOENT', JSON.stringify(tMiss))
fs.writeFileSync(path.join(N.logs, 'empty.txt'), '', 'utf8')
ok('空文件不算错（ok=true、bytes=0），别让"没日志"变成"读失败"', M.__readTextTail(path.join(N.logs, 'empty.txt'), 1000, 'auto').ok === true, '—')
let gbkOk = true
try { new TextDecoder('gbk') } catch { gbkOk = false }
const gbkFile = path.join(N.logs, 'gbk.txt')
fs.writeFileSync(gbkFile, Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x0A]), 'binary')
if (gbkOk) {
  const ta = M.__readTextTail(gbkFile, 1000, 'auto')
  ok('auto：UTF-8 解出替换符就自动换 GBK 再试，并把"用了哪种"如实回报（本机安装器日志就是 GBK）', ta.ok && ta.encoding === 'gbk' && ta.fellBack === true && ta.text.startsWith('中文'), JSON.stringify({ enc: ta.encoding, fell: ta.fellBack, head: ta.text.slice(0, 4) }))
  const te = M.__readTextTail(gbkFile, 1000, 'utf8')
  ok('显式要 utf8 就不偷偷换编码：出现替换符照实回报 hasReplacement（人要原文就得给原文）', te.ok && te.encoding.includes('utf-8') && te.hasReplacement === true, JSON.stringify({ enc: te.encoding, has: te.hasReplacement }))
  const tu = M.__readTextTail(bigLog, 1000, 'gbk')
  ok('显式要 gbk 也不倒回 UTF-8（哪怕解出来是花屏）', tu.ok && tu.encoding.includes('gbk'), JSON.stringify({ enc: tu.encoding }))
} else skip('GBK 解码三条', '本机 Node 的 ICU 不支持 gbk')

/* ── 6. 行筛选 ── */
const boxText = ['a 第一行', '█ ▄▄▄▄▄ █▀ █▀▀▀', '', 'b Login 成功', '', '', 'c OneBot 就绪'].join('\n')
const f1 = M.__filterLines(boxText, { lines: 100, now: new Date() })
ok('默认压掉二维码 ASCII 框线和多余空行（那 21 行框线不该淹死日志回报）', !/█/.test(f1.text) && /a 第一行/.test(f1.text) && /c OneBot 就绪/.test(f1.text), JSON.stringify({ text: f1.text, dropped: f1.droppedBoxOrBlank }))
const f2 = M.__filterLines(boxText, { raw: true, lines: 100, now: new Date() })
ok('raw:true 时一行都不压（要看原始输出就用它）', /█/.test(f2.text) && f2.count === 7, JSON.stringify({ count: f2.count }))
const f3 = M.__filterLines(boxText, { filter: 'Login|OneBot', lines: 100, now: new Date() })
ok('filter 能编成正正则就按正则（不区分大小写）走 filterMode=regex', f3.filterMode === 'regex' && f3.count === 2 && /LOGIN|Login/.test(f3.text) === false ? f3.count === 2 : f3.filterMode === 'regex' && f3.count === 2, JSON.stringify(f3))
const f4 = M.__filterLines('x[yy', { filter: '[yy', lines: 100, now: new Date() })
ok('filter 编不成正则就当子串包含（用户写 "[" 这种不该被拒）', f4.filterMode === 'contains' && f4.text === 'x[yy', JSON.stringify(f4))
const now = new Date(Date.parse('2027-06-15T10:00:00'))
const tsText = [napLogStamp(new Date(now.getTime() - 20 * 60000)) + ' [info] 旧的', napLogStamp(new Date(now.getTime() - 3 * 60000)) + ' [info] 新的'].join('\n')
const f5 = M.__filterLines(tsText, { sinceMin: 10, lines: 50, now })
ok('sinceMin 按行首时间戳筛"最近 N 分钟"（NapCat 的时间戳没有年份，由当前时间补）', f5.count === 1 && /新的/.test(f5.text), JSON.stringify({ text: f5.text, mode: f5.filterMode }))
const f6 = M.__filterLines(['keep me', 'x'.repeat(3000), 'last'].join('\n'), { lines: 2, now })
ok('lines 只回最后 N 行并标出被截（capped）', f6.count === 2 && f6.capped === true && f6.text.endsWith('last'), JSON.stringify({ count: f6.count, capped: f6.capped, tail: f6.text.slice(-20) }))

const fAnsi = M.__filterLines('\u001b[32minfo\u001b[39m 第一行\n\u001b[31merror\u001b[39m 第二行\nplain', { lines: 100, now: new Date() })
ok('ANSI 颜色码总是先剥掉（本机实测 NapCat 日志里全是 \u001b[32m 这类码：不剥会把 filter 的正则和给人看的文本一起弄脏）', fAnsi.strippedAnsiLines === 2 && !fAnsi.text.includes('\u001b') && fAnsi.text.includes('info 第一行'), JSON.stringify({ n: fAnsi.strippedAnsiLines, head: fAnsi.text.slice(0, 12) }))
const fAnsiRaw = M.__filterLines('\u001b[33mwarn\u001b[39m 一行\n\n\n空行占位', { raw: true, lines: 10, now: new Date() })
ok('raw:true 也不留 ANSI（raw 只管框线与连续空行，控制码不是内容）', !fAnsiRaw.text.includes('\u001b') && fAnsiRaw.strippedAnsiLines === 1, JSON.stringify(fAnsiRaw.text))
ok('剥完 ANSI 再筛：filter 写 "info" 就该命中带颜色的那行（不剥就匹配不到，因为控制码插在词前面）', M.__filterLines('\u001b[32minfo\u001b[39m x', { filter: 'info', lines: 5, now: new Date() }).count === 1, '—')

/* ── 7. 行首时间戳解析 ── */
const y1 = M.__lineTime('10-27 06:47:51 [info] x', new Date(Date.parse('2027-01-03T00:00:00')))
ok('跨年时不未来的行退到上一年（1 月 3 日看到 10-27 的行 ⇒ 去年的 10-27，按本地时区解）', y1 === Date.parse('2026-10-27T06:47:51'), new Date(y1).toISOString())
const y2 = M.__lineTime('10-27 06:47:51', new Date(Date.parse('2026-11-01T00:00:00')))
ok('同一年内正常补齐（不乱跳）', y2 === Date.parse('2026-10-27T06:47:51'), new Date(y2).toISOString())
ok('认不出的行回 null（进程 exited、框线、裸 URL 都不该被当时间戳）', M.__lineTime('Process exited.', new Date()) === null && M.__lineTime('█ ▄▄▄', new Date()) === null && M.__lineTime('13-45 99:99:99', new Date()) === null, '—')

/* ── 8. 二维码寿命与端口探测 ── */
const q1 = M.__qrTiming(Date.now() - 30000, new Date())
ok('码生成 30 秒时回 ageSec=30、还剩约 90 秒、没过期', q1.ageSec === 30 && q1.expiresInSec === 90 && q1.expired === false, JSON.stringify(q1))
const q2 = M.__qrTiming(Date.now() - 200000, new Date())
ok('超过 120 秒判过期且剩余秒数不为负', q2.expired === true && q2.expiresInSec === 0 && q2.ttlSec === 120, JSON.stringify(q2))
ok('拿不到 mtime 时只回 exists:false（不编一个时间糊上去）', M.__qrTiming(NaN, new Date()).exists === false, JSON.stringify(M.__qrTiming(NaN, new Date())))
const p = await freePort()
const srv = await openServer(p)
ok('端口探测：真开着的端口回 true（判"在不在跑"就靠它，不靠进程表也不靠带鉴权的 HTTP）', (await M.__portOpen('127.0.0.1', p, 900)) === true, p)
srv.close()
await sleep(120)
ok('端口没开回 false，而且不吊着（默认超时 900ms 内必返）', await (async () => { const t0 = Date.now(); const v = await M.__portOpen('127.0.0.1', p, 600); return v === false && Date.now() - t0 < 2000 })(), '—')

/* ── 9. 脱管起进程：不许吊住调用方（本机被拖 458 秒的那条） ── */
const slowRoot = path.join(tmp, 'slow'); fs.mkdirSync(slowRoot, { recursive: true })
const slowBat = path.join(slowRoot, 'slow.bat')
fs.writeFileSync(slowBat, '@echo off\r\nping -n 4 127.0.0.1 >nul\r\nexit /b 0\r\n', 'utf8')
const t0d = Date.now()
const sp = M.__spawnDetached(process.env.ComSpec || 'cmd.exe', ['/c', slowBat], { cwd: slowRoot, mode: 'log' })
const detachedMs = Date.now() - t0d
ok('脱管发出后**调用方立刻返回**（起一个要跑三秒多的脚本也不等它，本机实测这条是被拖 458 秒的原因）', detachedMs < 900 && typeof sp.pid === 'number' && sp.pid > 0, JSON.stringify({ ms: detachedMs, pid: sp.pid }))
const t0b = Date.now()
try { cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', slowBat], { cwd: slowRoot, stdio: 'ignore', windowsHide: true }) } catch { /* 超时被杀也算等到了 */ }
const blockingMs = Date.now() - t0b
ok('对照实验：同步等法确实要等满（证明这条断言测的是真差异，不是计时错觉）', blockingMs > 1500 && blockingMs > detachedMs * 3, JSON.stringify({ blockingMs, detachedMs }))
ok('窗口模式在回报里标成 console（宿主据此决定要不要藏窗口），log 模式标 log', M.__spawnDetached(process.env.ComSpec || 'cmd.exe', ['/c', slowBat], { cwd: slowRoot, mode: 'console' }).mode === 'console' && sp.mode === 'log', JSON.stringify({ log: sp.mode }))
await sleep(4200)

/* ── 10. 假 ctx 跑完整条 apply() ── */
const toolPort = await freePort()
// 让假 NapCat 的 webui.json 报这个空出来的端口：判"在不在跑"以 NapCat 自己的配置为准 ⇒ 本机真在跑的 6099 那份不会混进来
fs.writeFileSync(path.join(N.app, 'config', 'webui.json'), JSON.stringify({ host: '::', port: toolPort, token: 'a800943cd602', loginRate: 10, autoLoginAccount: '' }, null, 4), 'utf8')
fs.appendFileSync(bigLog, napLogStamp(new Date()) + ' \u001b[32minfo\u001b[39m [NapCat] [Core] 现场追加的带颜色码的一行\r\n' + napLogStamp(new Date()) + ' \u001b[33mwarn\u001b[39m 二维码已保存到 fake/path\r\n', 'utf8')   // 本机实测：NapCat 输出带 chalk 码且是 CRLF
process.chdir(tmp)
const registered = [], skillsProviders = [], disposers = []
const savedImages = []
const attachmentsCalls = []
let modelModalities = ['text', 'image']
const fakeCtx = {
  tools: { register: (def) => { registered.push(def) } },
  skills: { registerProvider: (fn) => { const pr = fn({ invalidate() { } }); skillsProviders.push(pr); return () => { pr.__closed = true } } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  get: (k) => {
    if (k === 'attachments') return { saveImages: async (imgs) => { imgs.forEach((i) => savedImages.push({ bytes: Buffer.byteLength(i.data), mediaType: i.mediaType })); return imgs.map((i, ix) => 'att-' + ix) } }
    if (k === 'llm') return { resolveModelInfo: async () => ({ inputModalities: modelModalities }) }
    return undefined
  }
}
M.apply(fakeCtx, { webuiPort: toolPort, startProbeMs: 300, stopWaitMs: 300, probeMs: 300 })
ok('apply() 只注册一只工具，名字是 napcat_log（形态就是"工具 + 说明书"，不铺一堆工具）', registered.length === 1 && registered[0].name === 'napcat_log', JSON.stringify(registered.map((r) => r.name)))
const def = registered[0]
ok('参数 schema 过得了宿主严格校验：action 必填、additionalProperties 明确给了 false、十个参数属性都在（含 quick 快速登录）', def.parameters.type === 'object' && def.parameters.additionalProperties === false && JSON.stringify(def.parameters.required) === JSON.stringify(['action']) && Object.keys(def.parameters.properties).length === 10 && 'quick' in def.parameters.properties, JSON.stringify({ req: def.parameters.required, props: Object.keys(def.parameters.properties) }))
ok('输出 schema 只钉 ok/message 且 additionalProperties:true（钉死自由形状会被判 "returned invalid output"）', def.output.schema.type === 'object' && def.output.schema.additionalProperties === true && Object.keys(def.output.schema.properties).sort().join(',') === 'message,ok', JSON.stringify(def.output.schema))
const rendered = def.output.render({}, { ok: true, image: 'att-0', nested: { a: 1 } })
ok('回报里的图是"附件引用"而不是 base64 字段，正文那份 JSON 里不重复塞图', rendered.length === 2 && rendered[1].type === 'image' && rendered[1].attachment === 'att-0' && !('image' in JSON.parse(rendered[0].text)), JSON.stringify(rendered.map((p) => p.type)))
const snapRead = (() => { try { return { s: JSON.parse(fs.readFileSync(path.join(home, 'status.json'), 'utf8')) } } catch (e) { return { err: String(e?.code || e?.message || e) } } })()
const ownLogNow = (() => { try { return fs.readFileSync(path.join(home, 'napcat-log.log'), 'utf8') } catch (e) { return '(自己的日志读不到：' + String(e?.code || e) + ')' } })()
ok('挂载即写了一份 status.json 快照（判现场不依赖 HTTP），里面带插件版本与用的哪个 NapCat 目录', !!(snapRead.s && snapRead.s.plugin === 'dsh-napcat-log' && snapRead.s.version === pkg.version && snapRead.s.napcat.dir === N.root), JSON.stringify({ err: snapRead.err, logTail: ownLogNow.split('\n').slice(-4, -1) }))
ok('本插件自己的日志记了挂载行与工具注册（写了哪只工具、用的是哪个目录）', /已注册工具 napcat_log/.test(fs.readFileSync(path.join(home, 'napcat-log.log'), 'utf8')) && /已挂载/.test(fs.readFileSync(path.join(home, 'napcat-log.log'), 'utf8')), '—')
const run = (a, exec) => def.execute(a, exec || {})
const ex = { agent: { session: { requestHeader: () => ({ config: { provider: 'x', model: 'y' } }) } } }

/* 11. status */
writeQr(N.qr, 30000)
const st = await run({ action: 'status' }, ex)
ok('status：端口不通 ⇒ running=false 且 modeGuess 说 stopped（判"在不在跑"用 TCP，不看进程表）', st.running === false && st.portOpen === false && /stopped/.test(st.modeGuess), JSON.stringify({ running: st.running, guess: st.modeGuess }))
ok('status：NapCat 目录是靠"探测"找到的并写明怎么钉死', st.napcat.foundBy.includes('探测') && st.notes.some((n) => /config\.napcatDir/.test(n)), JSON.stringify(st.napcat.foundBy))
ok('status：WebUI token 取自 NapCat 自己的 config/webui.json（权威），host 写 :: 时探测退回 127.0.0.1', st.webui.token === 'a800943cd602' && st.webui.probeHost === '127.0.0.1' && /权威/.test(st.webui.source) && st.webui.url === 'http://127.0.0.1:' + toolPort + '/webui?token=a800943cd602', JSON.stringify(st.webui))
ok('status：当前二维码给出 ageSec / 剩余秒 / 过期时刻，并把图作为附件回（附件走宿主 saveImages）', st.qrcode.exists === true && st.qrcode.ageSec >= 29 && st.qrcode.expiresInSec <= 91 && typeof st.image === 'string' && savedImages.length >= 1 && savedImages[0].mediaType === 'image/png', JSON.stringify({ q: st.qrcode, image: st.image, saved: savedImages.length }))
ok('status：四个启动脚本存在性都报出来，且报的正是我给它的那个端口（不是写死 6099）', Object.keys(st.napcat.launchers).length >= 4 && st.port === toolPort, JSON.stringify({ keys: Object.keys(st.napcat.launchers), port: st.port }))
ok('status：最后三行日志被搬出来（窗口版没文件时也不炸，回空数组）', Array.isArray(st.lastLogLines), JSON.stringify(st.lastLogLines))
fs.appendFileSync(bigLog, napLogStamp(new Date()) + ' \u001b[32minfo\u001b[39m [NapCat] [Test] 为了测快照刷新追加的一行\r\n', 'utf8')
const stRefresh = await run({ action: 'status' }, ex)
const snapAfter = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'status.json'), 'utf8')) } catch (e) { return { err: String(e?.code || e) } } })()
ok('status 每问一次就把 status.json 刷一份（文档承诺"每问即刷"；本机实机测试发现 0.1.0/0.1.1 只在挂载时写、问完文件还停在旧内容 ⇒ 这条钉住别回退）', !!(snapAfter.logFileStatus && stRefresh.logFileStatus) && snapAfter.logFileStatus.bytes === stRefresh.logFileStatus.bytes && snapAfter.at === stRefresh.at && stRefresh.logFileStatus.bytes > st.logFileStatus.bytes, JSON.stringify({ snap: snapAfter.logFileStatus && snapAfter.logFileStatus.bytes, res: stRefresh.logFileStatus && stRefresh.logFileStatus.bytes, before: st.logFileStatus && st.logFileStatus.bytes, err: snapAfter.err }))
const rd2b = await run({ action: 'read', lines: 3 })
ok('read：新追加的行也照旧交干净文本（ANSI 剥掉、行尾 \\r 不留，内容照得到）', rd2b.ok && !rd2b.text.includes('\u001b') && !/\r/.test(rd2b.text) && /为了测快照刷新/.test(rd2b.text), JSON.stringify({ tail: rd2b.text.slice(-40) }))

/* 12. read */
const rd = await run({ action: 'read', lines: 5 })
ok('read：默认尾读 60 行以内、压掉框线、回报用了哪种编码与读了多少字节', rd.ok && rd.linesReturned <= 5 && rd.linesReturned >= 1 && !/█/.test(rd.text) && rd.encodingUsed === 'utf-8' && rd.bytesRead > 0, JSON.stringify({ n: rd.linesReturned, enc: rd.encodingUsed, bytes: rd.bytesRead }))
ok('read：交出去的文本里没有 ANSI 控制码、也没有行尾 \\r（本机实测原文件是 chalk 上色 + CRLF；插件得给人干净行）', rd.ok && !rd.text.includes('\u001b') && !/\r/.test(rd.text) && rd.strippedAnsiLines >= 2, JSON.stringify({ ansi: rd.strippedAnsiLines, hasEsc: rd.text.includes('\u001b'), hasCR: /\r/.test(rd.text) }))
const rd2 = await run({ action: 'read', filter: 'Login|txz', lines: 50 })
ok('read：filter 走正则时只回命中行（扫码、二维码 URL、登录失败这类才是要盯的）', rd2.ok && rd2.filterMode === 'regex' && rd2.linesReturned >= 1 && rd2.text.split('\n').every((l) => /login|txz/i.test(l)), JSON.stringify({ mode: rd2.filterMode, n: rd2.linesReturned }))
const rd3 = await run({ action: 'read', filter: '编不成[的正则', lines: 50 })
ok('read：filter 编不成正则就退成子串（不报"正则非法"就把人挡掉）', rd3.filterMode === 'contains', JSON.stringify({ mode: rd3.filterMode, n: rd3.linesReturned }))
const rd4 = await run({ action: 'read', raw: true, lines: 200 })
ok('read:raw=true 把二维码框线也留下（要看那张 ASCII 码就靠它）', rd4.ok && /█/.test(rd4.text), '—')
const rd5 = await run({ action: 'read', encoding: 'gbk', lines: 10 })
ok('read：encoding 透传到解码（要 GBK 就给 GBK，回报里写清用了哪种）', rd5.ok && String(rd5.encodingUsed).includes('gbk'), JSON.stringify({ enc: rd5.encodingUsed }))
const logsBak = path.join(tmp, 'logs-hidden')
fs.renameSync(N.logs, logsBak)
const rd6 = await run({ action: 'read' })
ok('read：文件不存在时不只报错，还指路"只有重定向模式才有这份文件、想桥接就 start(mode:log)"', rd6.ok === false && rd6.code === 'ENOENT' && /mode:"log"|mode:.log./.test(rd6.hint || ''), JSON.stringify(rd6).slice(0, 200))
fs.renameSync(logsBak, N.logs)

/* 13. qr */
writeQr(N.qr, 15000)
const qr1 = await run({ action: 'qr' }, ex)
ok('qr：把当前码复制成 logs/<snapshotName> 并回报路径、生成时刻与剩余秒数', qr1.ok && qr1.snapshotSaved === true && qr1.snapshotPath === path.join(N.logs, 'qrcode-latest.png') && fs.existsSync(qr1.snapshotPath) && qr1.qrcode.ageSec >= 14, JSON.stringify({ snap: qr1.snapshotPath, q: qr1.qrcode }))
ok('qr：从日志里把解码 URL 那条捞出来给人当备用扫法', /txz\.qq\.com/.test(qr1.decodingUrlLine), String(qr1.decodingUrlLine).slice(0, 80))
const qrOld = await (async () => { writeQr(N.qr, 200000); const r = await run({ action: 'qr', save: false }, ex); return r })()
ok('qr：码已过期时 expiredNote 讲清"每 120 秒换一张 + 看 WebUI + 可再问一次"，message 里也说明这次没落盘，save:false 时确实没写文件', qrOld.ok === true && qrOld.qrcode.expired === true && /已经过了/.test(qrOld.expiredNote) && /再问一次|WebUI/.test(qrOld.expiredNote) && qrOld.snapshotSaved === false && qrOld.snapshotPath === '' && /没落盘/.test(qrOld.message), JSON.stringify({ exp: qrOld.qrcode.expired, saved: qrOld.snapshotSaved, note: String(qrOld.expiredNote).slice(0, 70) }))
writeQr(N.qr, 30000)
const qrImg = await run({ action: 'qr' }, ex)
ok('qr 默认把当前码作为图片附件回会话（宿主 attachments 给了 ref 就用）', qrImg.ok && typeof qrImg.image === 'string' && String(qrImg.image).startsWith('att-'), JSON.stringify({ image: qrImg.image }))
modelModalities = ['text']
const qrNoImg = await run({ action: 'qr' }, ex)
modelModalities = ['text', 'image']
ok('模型不接图片时不硬塞：这次没有 image 字段，但快照照落、路径与 WebUI 地址照给（图以卡片给人扫）', qrNoImg.ok && qrNoImg.image === undefined && qrNoImg.snapshotSaved === true && /qrcode-latest\.png/.test(String(qrNoImg.snapshotPath)) && /127\.0\.0\.1/.test(String(qrNoImg.webui)), JSON.stringify({ image: qrNoImg.image, snap: qrNoImg.snapshotPath }))
const attNone = await M.__attachImages(() => undefined, ex, [{ buffer: PNG_MIN, mediaType: 'image/png' }])
ok('宿主没给 attachments 服务时回 no_attachments 并说明"只回文件路径"，不抛异常', attNone.ok === false && attNone.reason === 'no_attachments' && /只回文件路径/.test(attNone.hint), JSON.stringify(attNone))
const attNoMod = await M.__attachImages((k) => (k === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } : { saveImages: async () => ['att-x'] }), ex, [{ buffer: PNG_MIN, mediaType: 'image/png' }])
ok('探针说模型不接图时回 model_no_image 且 hint 里带上是哪套模型', attNoMod.ok === false && attNoMod.reason === 'model_no_image' && /x\/y/.test(attNoMod.hint), JSON.stringify(attNoMod))
fs.rmSync(N.qr, { force: true })
const qrMiss = await run({ action: 'qr' })
ok('qr：还没有二维码文件时如实说"通常是没在跑或还没走到出码"并给下一步，不抛异常', qrMiss.ok === false && /还没有二维码文件|ENOENT/.test(qrMiss.message) && /start\(mode:"log"\)/.test(qrMiss.message), JSON.stringify(qrMiss).slice(0, 200))
writeQr(N.qr, 30000)

/* 14. start / stop / restart：脱管与守卫 */
const s1 = await run({ action: 'start', waitMs: 0 }, ex)
ok('start：调用侧不被拖住（totalCallMs 很小）且命令是脱管发出的（detached:true + 有 pid）', s1.ok && s1.detached === true && s1.totalCallMs < 1500 && typeof s1.spawnedPid === 'number', JSON.stringify({ ms: s1.totalCallMs, pid: s1.spawnedPid, cmd: s1.commandUsed }))
ok('start：默认走 log 模式并在回报里写明日志落在哪儿', s1.mode === 'log' && s1.logFile === path.join(N.logs, 'napcat-out.txt'), JSON.stringify({ mode: s1.mode, log: s1.logFile }))
ok('start：用的就是NapCatQQ\\start-log.bat 那只脚本（两个模式都保留 = 脚本还在、插件只是调它）', /start-log\.bat$/.test(String(s1.commandUsed)), String(s1.commandUsed))
const srv2 = await openServer(toolPort)
const s2 = await run({ action: 'start', waitMs: 0 }, ex)
ok('start：端口已经通着就**不再起第二份**（实测两份会互相顶掉，后起的把前一份打成 Process exited.）', s2.ok && s2.alreadyRunning === true && s2.spawnedPid == null && /已经在跑/.test(s2.message), JSON.stringify({ already: s2.alreadyRunning, pid: s2.spawnedPid }))
const s3 = await run({ action: 'start', mode: 'console', waitMs: 0 }, ex)
ok('start:mode=console 时也照发（只是回报里讲清"日志不进文件，只在它自己的控制台里"）', s3.mode === 'console' && (s3.alreadyRunning === true || /窗口模式/.test(s3.message)), JSON.stringify({ mode: s3.mode, msg: String(s3.message).slice(0, 60) }))
const sp2 = await run({ action: 'stop', waitMs: 0 }, ex)
ok('stop：只按本目录那份处理并在 note 里写明不碰别的目录的 QQ', sp2.ok && /NapCatQQ/.test(sp2.note) && /别的目录/.test(sp2.note), JSON.stringify(sp2.note))
await sleep(300)
srv2.close()
await sleep(200)
const sp3 = await run({ action: 'stop', waitMs: 300 }, ex)
ok('stop：本来没在跑时不谎报"停了"，直说"本来就没在跑（端口不通）"', sp3.ok && sp3.wasRunning === false && /本来就没在跑/.test(sp3.message), JSON.stringify({ was: sp3.wasRunning, msg: String(sp3.message).slice(0, 60) }))
const sq = await run({ action: 'start', quick: '1096964640', waitMs: 0 }, ex)
ok('start:quick 把 QQ 号转给启动器（本机实测 NapCat 支持 `NapCatWinBootMain.exe <QQ号>` 快速登录），并且写进插件自己的日志便于复盘', sq.ok && sq.alreadyRunning !== true && sq.quickLogin === '1096964640' && /快速登录=1096964640/.test(fs.readFileSync(path.join(home, 'napcat-log.log'), 'utf8')), JSON.stringify({ q: sq.quickLogin, already: sq.alreadyRunning }))
const sqBad = await run({ action: 'start', quick: '不是号', waitMs: 3000 }, ex)
ok('quick 形状不对（不是 5-12 位数字）就不转给命令行，照实回报 quickRejected —— 不拿任意字符串去拼 cmd', sqBad.ok && sqBad.quickLogin === '' && sqBad.quickRejected === '不是号' && /不像 QQ 号/.test(sqBad.message), JSON.stringify({ rej: sqBad.quickRejected, already: sqBad.alreadyRunning }))
const sqAlready = await (async () => { const s0 = await openServer(toolPort); let rr; try { rr = await run({ action: 'start', quick: '123456', waitMs: 0 }, ex) } finally { s0.close() }; await sleep(200); return rr })()
ok('已在跑时给 quick 不会偷偷生效：如实说"先 stop 再 start(quick)"（快登只在起新实例那一步有用）', sqAlready.alreadyRunning === true && sqAlready.quickLogin === '' && /先 stop/.test(sqAlready.message), JSON.stringify({ msg: String(sqAlready.message).slice(-50) }))
await sleep(300)
const sr = await run({ action: 'restart', waitMs: 0 }, ex)
ok('restart：没在跑时跳过"先停"直接起（不去杀不存在的东西），起法仍走脱管', sr.ok && sr.stopReport == null && sr.detached === true && sr.totalCallMs < 1500, JSON.stringify({ stop: sr.stopReport, ms: sr.totalCallMs }))
const bad = await run({ action: '瞎点' })
ok('认不出的 action 回 bad_action 并列出合法值（不静默当 status 跑一遍）', bad.ok === false && bad.code === 'bad_action' && /status\/read\/qr\/start\/stop\/restart/.test(bad.message), JSON.stringify(bad))
const nodir = await (async () => {
  // 挪 cwd 到一片没有 NapCatQQ 的地方（比 rename 目录稳：刚才 start/stop 脱管起的进程 cwd 还指着假目录，Windows 不让你改名occupied 目录）
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ napcatDir: path.join(tmp, 'decoy') }), 'utf8')
  process.chdir(path.join(tmp, 'lonely', 'a', 'b'))
  let r
  try { r = await run({ action: 'start', waitMs: 0 }) } finally { process.chdir(tmp); fs.rmSync(path.join(home, 'config.json'), { force: true }) }
  return r
})()
ok('找不到 NapCat 目录时 start 如实回 no_dir 并教怎么钉死（不瞎猜路径）', nodir.ok === false && nodir.code === 'no_dir' && /napcatDir/.test(nodir.message), JSON.stringify(nodir))

/* 15. 配置现读与不写死 */
const cfgFile = path.join(home, 'config.json')
fs.writeFileSync(cfgFile, JSON.stringify({ napcatDir: N.root, webuiPort: toolPort, defaultMode: 'console' }), 'utf8')
const st2 = await run({ action: 'status' }, ex)
ok('家目录 config.json 用的时候现读：改完不必重启就换了目录/端口/默认模式', st2.napcat.dir === N.root && st2.port === toolPort && st2.config.defaultMode === 'console' && st2.napcat.foundBy === 'config.napcatDir', JSON.stringify({ dir: st2.napcat.dir, port: st2.port, mode: st2.config.defaultMode }))
fs.writeFileSync(cfgFile, JSON.stringify({ webuiPort: '不是数', defaultMode: '瞎写' }), 'utf8')
const st3 = await run({ action: 'status' }, ex)
ok('config.json 里写坏值也不崩、且坏值回退到默认（webuiPort 回内置值，模式回 log）', st3.ok === true && st3.config.defaultMode === 'log' && typeof st3.port === 'number' && st3.port > 0, JSON.stringify({ port: st3.port, mode: st3.config.defaultMode }))
fs.rmSync(cfgFile, { force: true })
ok('源码里没有写死本机的 NapCat 路径 / token / 版本号（换人换机也能用）', !/D:\\\\DSH_WorkSpace|NapCatQQ\\\\NapCat\.52230|a800943cd602|9\.9\.33-52230/i.test(src), JSON.stringify((src.match(/NapCatQQ|a800943|9\.9\.33/g) || []).slice(0, 6)))
ok('源码里没有同步等进程的调用（execSync/execFileSync/spawnSync 都不许有 —— 那正是被拖 458 秒的写法）', !/execSync|execFileSync|spawnSync/.test(src), JSON.stringify((src.match(/exec\w*Sync|spawnSync/g) || []).slice(0, 4)))

/* 16. 说明书 */
const prov = skillsProviders[0]
const list1 = await prov.list()
ok('说明书目录里有 1 份（napcat-log），带 provider/rank/resourceBase，且不把本地绝对路径泄进目录条目（locator 从 list 里摘掉）', list1.length === 1 && list1[0].name === 'napcat-log' && list1[0].provider === 'dsh-napcat-log' && list1[0].source === 'bundled' && !('locator' in list1[0]) && !('from' in list1[0]) && list1[0].rank === 620 && /^[A-Za-z0-9_:/.-]+$/.test(list1[0].resourceBase.path), JSON.stringify(list1))
ok('frontmatter 的 description 与 whenToUse 被当真（目录里那份就是它们）', /读 NapCat/.test(list1[0].description) && /在不在跑|日志/.test(list1[0].whenToUse), JSON.stringify({ d: list1[0].description.slice(0, 30), w: list1[0].whenToUse.slice(0, 20) }))
const got = await prov.get(list1[0])
ok('get() 回正文 + 底座脚注，且脚注排在**最后**（讲清只有一只工具、什么模式才有日志、当前用的是哪个 NapCat 目录）', got.content.includes('桥接的第一前提') && got.content.trim().endsWith('升级不冲）。') && got.content.includes('本插件的底座（dsh-napcat-log v' + pkg.version + '）') && got.content.includes('重定向模式'), JSON.stringify({ tail: got.content.slice(-40) }))
const overFile = path.join(home, 'skills'); fs.mkdirSync(overFile, { recursive: true })
fs.writeFileSync(path.join(overFile, 'napcat-log.md'), '---\nname: napcat-log\ndescription: 覆盖版说明\ndescription: 覆盖版说明\n---\n\nOVERRIDE 正文标记\n', 'utf8')
const list2 = await prov.list()
ok('家目录放同名 md 就顶掉包内那份（不必重启、升级也不冲）', list2[0].source === 'override' && (await prov.get(list2[0])).content.includes('OVERRIDE 正文标记'), JSON.stringify({ src: list2[0].source }))
fs.rmSync(path.join(overFile, 'napcat-log.md'), { force: true })
ok('说明书里写明两条判读口径：ErrCode 3 是码超时、serverErrorCode 168 是腾讯侧账号风控（不是本机或插件的毛病）', /ErrCode: 3|ErrCode 3/.test(fs.readFileSync(path.join(pkgDir, 'skills', 'napcat-log.md'), 'utf8')) && /168/.test(fs.readFileSync(path.join(pkgDir, 'skills', 'napcat-log.md'), 'utf8')), '—')

/* 17. 返回值必须是无损 JSON（宿主严格校验） */
const scanLossless = (v, p = '$', out = []) => {
  if (typeof v === 'number' && !Number.isFinite(v)) out.push(p + '=' + String(v))
  else if (typeof v === 'bigint') out.push(p + ' 是 BigInt')
  else if (v === undefined) out.push(p + '=undefined')
  else if (Array.isArray(v)) v.forEach((x, i) => scanLossless(x, p + '[' + i + ']', out))
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => scanLossless(x, p + '.' + k, out))
  return out
}
const results = [st, rd, rd2, qr1, qrOld, s1, s2, sp2, sr, bad, st2, def.output.render({}, st)]
ok('每个动作的返回值都是无损 JSON（没有 NaN/Infinity/BigInt/undefined，宿主才不会判 "value is not lossless JSON"）', results.every((r) => scanLossless(r).length === 0), JSON.stringify(results.map((r) => scanLossless(r)).filter((x) => x.length)[0] || []))
ok('每个 JSON 化的回报里都不出现本机真实家目录（C:\\Users\\...）作为唯一线索时也不泄露用户主目录名', (() => { const s = JSON.stringify(st); return !s.includes(os.homedir()) || s.includes(N.root) })(), '—')

/* 18. 卸载与收尾 */
for (const d of disposers) d()
ok('卸载：disposer 能把 skill 提供方摘掉（provider 被标记关闭），且不抛', skillsProviders.length === 1 && skillsProviders[0].__closed === true, JSON.stringify(skillsProviders.map((p) => !!p.__closed)))
const ownLog = fs.readFileSync(path.join(home, 'napcat-log.log'), 'utf8')
ok('本插件日志记了每次 start/stop 实际发的命令（谁起的、用哪只脚本、有没有带快速登录号，出事能复盘）', /start（mode=log/.test(ownLog) && /脱管发出/.test(ownLog) && /stop 脱管发出/.test(ownLog), JSON.stringify(ownLog.split('\n').slice(-3, -1)))
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 收尾删不掉就算了 */ }
console.log('\ndsh-napcat-log 离线自检：' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : '') + (skipped ? '，' + skipped + ' 项跳过' : ''))
console.log(fail ? 'SOME FAIL' : 'ALL PASS')
process.exit(fail ? 1 : 0)
