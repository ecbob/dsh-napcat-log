# dsh-napcat-log

把 **NapCat**（基于 NTQQ 的 QQ 机器人框架）的运行日志与登录二维码桥进 DSH 的小插件：纯 JS、零运行时依赖（只用 node 内置 `fs/path/os/net/child_process`），**一只工具 + 一份按需加载的说明书**。

它做两件事：**读**（日志、二维码、在不在跑）和**起停**（脱管）。它不发消息、不碰 QQ 接口、不起定时器、不加界面分区。

## 现在有的能力

`napcat_log {action: …}`

| action | 干什么 | 实测口径 |
|---|---|---|
| `status` | 在不在跑（TCP 探 WebUI 端口）、跑的是**重定向**还是**窗口**模式（`modeGuess`）、WebUI 地址与 token、当前登录码还剩多少秒、NapCat 装在哪 + 靠哪条规则找到的、四个启动脚本在不在、最后三行日志 | 判"在不在跑"用 TCP 连接，不靠进程表也不靠带鉴权的 HTTP |
| `read` | 尾读 `logs/napcat-out.txt`：`lines`（1-2000，默认 60）、`filter`（能编成正则就按正则、编不成就当子串包含）、`sinceMin`（按行首 `MM-DD HH:MM:SS` 时间戳筛最近 N 分钟）、`encoding`（`auto` 默认：先 UTF-8，出现替换符再换 GBK，并回报 `encodingUsed`）、`raw`（true 时连二维码 ASCII 框线一起给） | 文件被 NapCat 的重定向句柄占着 —— 本插件用共享读打开，实测读得到 |
| `qr` | 把 `…\napcat\cache\qrcode.png` 快照成 `logs/qrcode-latest.png`，**并把图当图片附件直接回会话**；回 `ageSec / expiresInSec / expired`（一张码约 120 秒）、顺带从日志里捞出 `txz.qq.com/p?k=…` 那条解码 URL；`save:false` 只问不落盘 | 模型不接图或宿主不给附件服务时退回只给路径 |
| `start` / `restart` / `stop` | 起停这份实例，`mode:"log"`（默认，日志进文件）或 `mode:"console"`（开可见窗口）。`start` 先看端口，**通着就不起第二份**；`restart` 停不干净会如实回 `still_running`；`stop` 只按 `Path` 前缀杀**本目录那份** QQ | 一律 `stdio:'ignore' + detached + unref` |

## 为什么起停必须脱管（本机实测的两条）

1. 从"输出被捕获"的 shell 里 `cmd /c` 调启动脚本，调用会被一路拖到 NapCat 退出 —— 本机实测 **458.27 秒**。插件用 detached + `unref()`，调用立刻返回。
2. 启动器若还是调用方的子进程，**结束调用方就连带端掉 NapCat 整棵树** —— 本机真丢过一次（杀一条被拖住的作业 ⇒ 4 个 `QQ.exe` 全没、端口当场不监听）。脱管之后宿主重启/会话结束都不会顺手把它带走。

## 工具签名

```
napcat_log {
  action: "status" | "read" | "qr" | "start" | "stop" | "restart",
  mode?:     "log" | "console",     // start/restart 用；缺省 = config.defaultMode（默认 log）
  lines?:    number,                // read：1-2000，默认 60
  filter?:   string,                // read：正则优先、子串兜底（都不区分大小写）
  sinceMin?: number,                // read：只看最近 N 分钟的行（按行首时间戳）
  encoding?: "auto" | "utf8" | "gbk",
  raw?:      boolean,               // read：不压二维码框线与空行
  save?:     boolean,               // qr：默认 true 落 logs/<snapshotName>
  waitMs?:   number                 // start/stop：起停后最多再等这么久看端口变化（0 = 纯脱管）
}
```

## 家目录（删掉即彻底回滚）

`$DSH_HOME/dsh-napcat-log/`

| 文件 | 作用 |
|---|---|
| `config.json` | 运行时配置，**用的时候现读**（改完不必重启），优先级高于 patch 里的 config |
| `status.json` | 状态快照：挂载即写一份、每次 `status` 再刷一份 —— 判"插件挂上了没、用的是哪个 NapCat 目录"不必依赖 HTTP |
| `napcat-log.log` | 本插件自己的日志：每次 `start/stop/restart` 实际发了哪条命令、pid 多少 |
| `skills/napcat-log.md` | 使用者写的覆盖版说明书（同名即顶掉包内那份，升级不冲） |

NapCat 那边**不写死路径**：按 `config.napcatDir` → 环境变量 `NAPCAT_DIR` → 探测（当前目录、家目录、以及它们上一级里名叫 `NapCatQQ` 的目录），判"真是 NapCat"的标准是里面有一层 `NapCat.<数字>.Shell`；版本目录从 `versions/` 里现挑，NapCat 升版也不用改插件。

## 配置（`cordis.patch.yml` 的 config，或插件家目录 `config.json`）

`napcatDir` `webuiHost`(127.0.0.1) `webuiPort`(6099) `defaultMode`(log) `startProbeMs`(6000) `stopWaitMs`(4000) `probeMs`(900) `maxBytes`(200000) `snapshotName`(qrcode-latest.png) `logLevel`(info) —— 数字全部夹范围、模式走白名单，坏值不会把插件搞崩。

## 装

```bash
npm pack --pack-destination dist
# 装进 profile（按 DSH 的规矩：file: 依赖 + 核对 dsh.profile.bundles 里那行在不在），然后重启宿主
```

自检（离线，不需要 NapCat 在跑）：

```bash
node scripts/selftest.mjs
```

## 边界（它不会做的事）

- 不启动 QQ、不管 QQ 登录状态机、不替你扫码；登录失败它只把 `ErrType/ErrCode` 或 `serverErrorCode` 那句话搬到你看的地方（`ErrCode 3` = 码超时没人扫；`168` = 腾讯侧账号风控）。
- 不解析 OneBot API、不发消息、不订阅事件、不轮询 QQ —— 只有你调用它时才动。
- 不起定时器、不开 webServer 路由、没有客户端分区（形态就是"工具 + 说明书"）。
- 不写死任何人的绝对路径、账号、token；读不到就如实回 `code` 和该怎么修。
- 窗口模式的日志不进文件 ⇒ 那种跑法下 `read` 读到的是上一次的旧内容，插件在 `modeGuess` 里会这么提示。

## 实现参考

- 插件骨架（`apply(ctx, config)`、`ctx.tools.register` 的参数清洗与"返回值必须无损 JSON"、`ctx.skills.registerProvider` 的 candidate 形状与 `resourceBase/locator/source`、家目录 `config.json` 现读、`status.json` 快照、说明书末尾追加底座脚注）照本仓库另一只插件 **`dsh-bili-skill`** 在同一台机器上实测过的写法来做，不引新机制。
- 图片以附件形式回会话的形状（`{type:'image', attachment: ref}` + 宿主 `attachments.saveImages` + 先探模型 `inputModalities` 再决定发不发）同样取自 `dsh-bili-skill` 的实测契约。
- 关于 NapCat 本身的事实（日志重定向才有可读文件、二维码约 120 秒自动换、`ErrType 1/ErrCode 3` 的含意、`webui.json` 里的 token 才是权威、QQ 按 `--user-data-dir` 单实例、起两份会互相顶掉、GBK/UTF-8 混着的编码坑、`taskkill /f /im QQ.exe` 会连别的 QQ 一起杀）**全部来自本机 2026-10-26 ~ 10-27 的实测日志**，不是照文档猜的；被桥接的 NapCat 自有其 "Limited Redistribution License"（非商用），与本插件的 MIT 各管各的。
