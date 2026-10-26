---
name: napcat-log
description: 读 NapCat（QQ 机器人框架）的运行日志与登录二维码，并能脱管起停它：日志文件在哪、什么模式才有日志、ErrCode 3 与 serverErrorCode 168 怎么分、二维码两分钟就过期该怎么办。
whenToUse: 要判断 NapCat 在不在跑、看它的登录/扫码/OneBot 事件日志、需要当前登录二维码，或要起停这份实例时。
---

## 一句话口径

`napcat_log` 是本机 NapCat 的**耳朵和手**：耳朵 = 读它的日志与二维码，手 = 脱管起停。**它自己不发消息、不碰 QQ 接口**，也不替你决定要不要登录。

## 桥接的第一前提：哪种启动方式才有日志

| 启动方式 | 日志去哪 | 本插件读得到吗 |
|---|---|---|
| `start(mode:"log")`（默认，重定向） | `<NapCatQQ>\logs\napcat-out.txt` / `napcat-err.txt` | ✅ 读得到（`read`） |
| `start(mode:"console")`（窗口版） | 只在那个可见控制台窗口里 | ❌ 文件不会长，`read` 读到的是**上一次**的旧内容 |

⇒ 判据也写在 `status.modeGuess`：端口通着、但日志文件的修改时间已经超过约 140 秒 ⇒ 多半是窗口模式在跑（`Process exited.` 也会停在旧文件尾部）。想持续桥接就用 log 模式；窗口版留着"我要亲眼看"。

## 六个动作怎么用

```
napcat_log {action:"status"}                                  # 在不在跑 / 哪种模式 / WebUI 地址+token / 当前码剩多少秒 / 用的是哪个目录
napcat_log {action:"read", lines:60}                          # 尾读 60 行（默认压掉二维码 ASCII 框线）
napcat_log {action:"read", filter:"Login|扫码|二维码|OneBot"}  # 能编成正则就按正则（不区分大小写），编不成就当子串
napcat_log {action:"read", sinceMin:10, raw:true}             # 最近 10 分钟的行，原样给（连框线都不压）
napcat_log {action:"read", encoding:"gbk"}                    # 这台机器上同类目录里也有 GBK 的东西；默认 auto 会自动判并回报 encodingUsed
napcat_log {action:"qr"}                                      # 把当前登录码快照成 logs/qrcode-latest.png，并把图当附件回会话
napcat_log {action:"qr", save:false}                          # 只问不落盘
napcat_log {action:"start"}                                   # 脱管起（立刻返回，不等 NapCat 退出）
napcat_log {action:"start", mode:"console"}                   # 开可见窗口的起法（日志不进文件）
napcat_log {action:"stop"}                                    # 只停这个目录底下的那份
napcat_log {action:"restart"}                                 # 先停再起（停不干净会如实回 still_running）
```

## 三条判读口径（别误诊）

1. **`Login Error, ErrType: 1 ErrCode: 3`** = 这张登录二维码**超时没人扫**（NapCat 每约 120 秒自动换一张，`cache\qrcode.png` 被反复覆写），不是账号有问题、也不是插件坏了。
2. **`serverErrorCode 168`（"你的账号近期存在安全风险，部分功能…"）** = **腾讯侧账号风控**，NapCat 与本机都改不了：要先在手机 QQ 里把安全验证走通（正常登录一次/设备验证/改密码），再来扫码。`qr`/`read` 只负责把这句话原样搬到你看的地方。
3. **端口通 ≠ 已登录**：6099（WebUI）在 NapCat 一起来就通，登录与否要看日志里的 `请扫描…` / `二维码已被扫描` / 有没有报成功。`status.lastLogLines` 就是给你看最后三行的。

## 二维码时效与用法

- 一张码约 **120 秒**有效（`qrcode.ttlSec` 常量就是它）。`status`/`qr` 会回 `ageSec`、`expiresInSec`、`expired`。
- 过期了不必慌：NapCat 自己会换新的；**要稳就拿 WebUI 那张**（它会刷新、还显示"已扫码/等你在手机上确认"）：`status.webui.url`。token 的来源是 **NapCat 自己的 `config/webui.json`**（权威），不是从日志里猜的。
- `qr` 会把当前码复制到 `logs/qrcode-latest.png` 并尝试作为**图片附件**回会话；模型不接图或宿主不给附件服务时，它退回只给路径（回报里 `image` 字段缺席 + 说明写在 hint）。

## 起停的硬规矩（本机踩过的两条，插件已按此实现）

- **脱管**：起进程一律 `stdio:'ignore' + detached + unref` ⇒ ① 调用**立刻返回**（从被捕获输出的 shell 里直接 `cmd /c` 调启动脚本会被拖到 NapCat 退出，本机实测 **458.27 秒**）；② NapCat **不挂在会话/宿主底下**，宿主重启或作业被杀都不会顺手把它带走（本机真丢过一次：杀作业 ⇒ QQ 全组跟着没、6099 当场不监听）。
- **同一目录别起两份**：`start` 会先看端口，通着就不再起（回报 `alreadyRunning:true`）。实测两份会互相顶掉：后起的那一份把前一份打成 `Process exited.`。要换模式先 `stop`。
- `stop` 只按 `Path` 前缀杀本目录那份 QQ，**不会**碰别的目录里装的 QQ（官方 `napcat.kill.qq.bat` 是 `taskkill /f /im QQ.exe`，会把所有 QQ 一起干掉）。

## 找不到目录时怎么办

`napcat_log` 按 `config.napcatDir` → 环境变量 `NAPCAT_DIR` → 探测（当前目录、家目录、以及它们上一级里名叫 `NapCatQQ` 的目录）这个顺序找，判"真是 NapCat"的标准是里面有一层 `NapCat.<数字>.Shell`。`status.napcat.foundBy` 会写明这次是靠哪条找到的；想钉死就在插件家目录 `config.json` 写 `napcatDir`（用的时候现读，**改完不必重启**），或在 `cordis.patch.yml` 的 config 里给。`versionHint` 是从 `versions/` 里现挑的最新版本目录名 —— 不写死版本号，NapCat 升了版也不用改插件。
