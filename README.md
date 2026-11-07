# cfddns-openwrt

[cfddns](https://github.com/xjetry/cfddns) 的 OpenWrt 软件源（opkg feed），两个包：

- `cfddns`（0.3.1-1）：核心，UCI（`/etc/config/cfddns`）+ procd 服务；直接打包 cfddns v0.3.1 Release 的 `cfddns-linux-arm64`（静态链接，SHA256 固定），架构 `aarch64_cortex-a53`
- `luci-app-cfddns`（0.1.1）：LuCI 页面（服务 → Cloudflare DDNS），「运行状态」「基本设置」两个标签页，架构 `all`

软件源：`https://xjetry.github.io/cfddns-openwrt/aarch64_cortex-a53`

索引用 usign 签名，公钥 [`cfddns.pub`](cfddns.pub)，指纹 `af1661a3e9bf4ee0`。

---

## 支持范围

| 设备 | 固件 | 状态 |
|------|------|------|
| GL-E5800 / Mudi 7 | GL 原厂固件，OpenWrt 23.05.4（`sdx75/generic`） | 待真机验收 |
| GL-BE10000 / Slate 7 Pro | GL 原厂固件 4.8.6，OpenWrt 21.02（`mediatek/mt7987`） | 部分通过（2026-10-29，仅 IPv4），见下 |
| GL-BE14000 / Flint 4 | GL 原厂固件 4.9.2，OpenWrt 21.02（`mediatek/mt7988`） | 待真机验收 |

三台的 opkg 都接受 `aarch64_cortex-a53`。包用官方 OpenWrt 23.05.4 `mediatek/filogic` SDK 打包，不是 GL 的厂商 SDK。真机验收完成前不算已支持；其他设备即使架构匹配也未验证，不要靠强改 opkg 架构安装。

GL-BE10000 上已通过的项（[验收记录](docs/acceptance/2026-10-27-gl-be10000.md)，验收版本 `cfddns` 0.3.0-1、`luci-app-cfddns` 0.1.0）：

- 按本 README 导入公钥、添加软件源、`opkg update`、`usign -V` 校验输出 `OK`，再安装 `cfddns` 和 `luci-app-cfddns`；该固件的 `opkg.conf` 没有 `check_signature`
- UCI / env 权限 `0600`，进程参数和日志里没有 Token；`-once`、`-inspect`（记录存在 / 不存在 / 同名多条 / Token 无效 / 未配置），以及服务启动、停止、重启和 `enabled` 开关
- Cloudflare A 记录的创建、内容不同时更新、无变化周期不写入（测试线路上 `1.1.1.1` 不通，IPv4 探测经临时中转）；重启后自启，运行状态重建
- LuCI 页面用到的 rpcd 调用（经 uhttpd `/ubus`、只授予本应用和 `luci-base` 的会话）：保存并应用（启用 / 停用）、启动 / 停止 / 重启、状态读取和 inspect，以及 ACL 对无关文件、无关命令和其他配置的拒绝

未验证：IPv6 / AAAA（设备没有原生 IPv6）、浏览器里的页面显示、版本升级。验收中发现的问题（例如 IPv4 探测依赖 `1.1.1.1`，在该设备的上行网络上不通）见验收记录。其中“在 LuCI 清空 Token 后 `/etc/cfddns.env` 仍保留旧 Token”已在 `cfddns` 0.3.0-2、`luci-app-cfddns` 0.1.1 修复，尚未在真机上复验。

core v0.3.1（`cfddns` 0.3.1-1）起，`1.1.1.1`（v6 为 `2606:4700:4700::1111`）不通时 IPv4 / IPv6 探测改用 `www.cloudflare.com`，尚未在真机上验收。

---

## 安装

> 在路由器上以 root 执行，按顺序来。

导入公钥，先核对指纹：

```sh
wget -O /tmp/cfddns.pub https://raw.githubusercontent.com/xjetry/cfddns-openwrt/main/cfddns.pub
usign -F -p /tmp/cfddns.pub      # 必须输出 af1661a3e9bf4ee0
opkg-key add /tmp/cfddns.pub     # 没有 opkg-key 时：cp /tmp/cfddns.pub /etc/opkg/keys/af1661a3e9bf4ee0
```

添加软件源（只这一行）并更新：

```sh
echo 'src/gz cfddns https://xjetry.github.io/cfddns-openwrt/aarch64_cortex-a53' >> /etc/opkg/customfeeds.conf
opkg update
```

校验索引签名。`/etc/opkg.conf` 里有 `option check_signature` 时，`opkg update` 已用 `/etc/opkg/keys` 校验过 `Packages.sig`，签名不对会拒绝这个源；GL 原厂固件可能没有这一行，opkg 就不校验签名，这一步**必做**（有这一行时再做一遍也无妨）。不要为此改 `opkg.conf`：

```sh
grep '^option check_signature' /etc/opkg.conf   # 没有输出：opkg 不校验签名
wget -O /tmp/cfddns-Packages.sig https://xjetry.github.io/cfddns-openwrt/aarch64_cortex-a53/Packages.sig
(zcat /var/opkg-lists/cfddns 2>/dev/null || cat /var/opkg-lists/cfddns) | usign -V -m - -x /tmp/cfddns-Packages.sig -p /etc/opkg/keys/af1661a3e9bf4ee0
```

`/var/opkg-lists/cfddns` 是 `opkg update` 刚下载、安装时 opkg 要用的索引（`/var/opkg-lists` 是 `lists_dir` 的默认值），按下载的 `Packages.gz` 原样保存；签名针对解压后的 `Packages`，所以先解压再交给 `usign`，和 opkg 自己校验（`opkg-key verify`）时一样。`-p` 只认本软件源的公钥。必须输出 `OK`；否则停下，不要执行 `opkg install`：重新 `opkg update`、再下载签名校验一次（可能刚好赶上发布），仍失败就不要安装。索引里有每个 ipk 的 SHA256，opkg 下载时会核对。

输出 `OK` 后安装：

```sh
opkg install luci-app-cfddns     # 页面 + 核心，自动带上 cfddns 和 ca-bundle
opkg install cfddns              # 只要核心：UCI + 服务，没有页面
```

升级：先 `opkg update`，按上面校验索引签名，输出 `OK` 后再升。装了页面的两个包一起升：新的 `cfddns` 配旧的 `luci-app-cfddns`，在 LuCI 清空 Token 后运行中的服务仍在用旧 Token。只装核心的只升 `cfddns`：`opkg upgrade` 会把列出但没装的包装上，连同 `luci-base`。

```sh
opkg upgrade cfddns luci-app-cfddns   # 装了页面：两个一起升
opkg upgrade cfddns                   # 只装了核心
```

---

## 配置

`/etc/config/cfddns`（UCI）是唯一配置来源，推荐用 LuCI 页面修改，也可以用 `uci`：

| 选项 | 默认 | 说明 |
|------|------|------|
| `enabled` | `0` | `1` 运行并开机自启 |
| `domain_v4` | — | IPv4 域名（A） |
| `domain_v6` | — | IPv6 域名（AAAA） |
| `v6_iface` | — | IPv6 取该网卡的稳定地址；需要同时设 `domain_v6` |
| `token` | — | **必填** Cloudflare API Token（`Zone:DNS:Edit` + `Zone:Zone:Read`） |
| `period` | `5m` | 更新周期，最小 `10s` |

`domain_v4` / `domain_v6` 至少一个。

命令行配置时，不要把 Token 写在命令行上（如 `uci set`），否则它会进进程参数和 shell 历史。先把 Token 存进 `0600` 的临时文件，这一行执行后粘贴 Token，回车，再按 `Ctrl-D`：

```sh
(umask 077; cat >/tmp/cfddns.token)
```

再用 shell 内建的 `printf` 把它从 stdin 交给 `uci batch`，删除临时文件，然后设置其余选项：

```sh
printf "set cfddns.main.token='%s'\n" "$(cat /tmp/cfddns.token)" | uci batch
rm -f /tmp/cfddns.token
uci set cfddns.main.domain_v4=home.example.com
uci set cfddns.main.enabled=1
uci commit cfddns
/etc/init.d/cfddns enable
/etc/init.d/cfddns reload        # 重新生成 env；enabled=1 重启，enabled=0 停止
```

`/etc/cfddns.env` 由 `/usr/libexec/cfddns-config` 从 UCI 生成（`0600`），每次 start / reload 覆盖：不要手改，也不要 `source` / `.` 它，Token 里可能有 `$`、反引号等字符。

清空 `token`，或同时清空 `domain_v4` 和 `domain_v6` 后，下一次保存并应用或 `reload` 会删除 `/etc/cfddns.env` 并停止服务（`enabled=0` 时算成功，`enabled=1` 时报错），`cfddns -inspect`、`cfddns -once` 也不能再使用旧 Token，「运行状态」显示尚未配置。其他无效值（周期、域名格式等）只报错，保留上一份可用的 env。

删除凭据要清空 `token`（LuCI 里清空后保存并应用，或用上面 stdin 交给 `uci batch` 的写法），不要 `uci delete cfddns.main`：整段不存在算无效配置，会保留上一份 env。命令行：

```sh
echo "set cfddns.main.token=''" | uci batch
uci commit cfddns
/etc/init.d/cfddns reload
```

从 0.3.0-1 升级不会自动处理已经残留的 env：如果之前清空过 Token，升级后执行一次 `/etc/init.d/cfddns reload`，或在 LuCI 点一次保存并应用。

运行状态：LuCI「运行状态」标签页，或 `/var/run/cfddns.status`；日志 `logread -e cfddns`。

卸载：`opkg remove luci-app-cfddns cfddns`（同时删除 `/etc/cfddns.env`）。

---

## 从 install.sh / `-install` 迁移

`cfddns` 包首次安装时，只要 `/usr/bin/cfddns`、`/etc/init.d/cfddns`、`/etc/cfddns.env` 任一存在（包括失效的符号链接）就中止安装：不覆盖、不接管手动安装，也不导入旧配置。先卸载手动安装：

```sh
cp -p /etc/cfddns.env /root/cfddns.env.bak   # 备份，含 Token
cfddns -uninstall                            # 停服务，删 init 脚本 / env / 二进制
```

再按「安装」一节导入公钥、添加软件源、`opkg update`、校验索引签名，输出 `OK` 后 `opkg install`。然后按备份里的 `CFDDNS_V4` / `CFDDNS_V6` / `CFDDNS_V6_IFACE` / `CFDDNS_TOKEN` / `CFDDNS_PERIOD` 填 UCI，确认运行正常后删除备份。手动安装的 `-port` / `-passwd` HTTP 触发在包里没有对应选项。

---

## 构建与发布

```sh
make check      # shell / JS / feed 测试，需要 node
make feed SDK_DIR=<sdk> CORE_VERSION=0.3.1 OUTPUT_DIR=<dir> FEED_KEY=<usign 私钥>
```

- `SDK_DIR`：OpenWrt 23.05.4 `mediatek/filogic` SDK（x86_64 Linux，非 root 运行）。`feeds.conf` 会被替换成本仓库（`src-link`）加 SDK 自带的 luci feed。
- 核心包不编译 Go：SDK 下载 Release 的 `cfddns-linux-arm64` 并按 `PKG_HASH` 校验，打包后再核对 ipk 里的 `/usr/bin/cfddns`。
- LuCI 包不压缩 JS，构建后核对其中每个文件都与 `luci/applications/luci-app-cfddns` 逐字节一致。`luci.mk` 只用 `PKG_VERSION` 作版本（不带 `PKG_RELEASE`），改 LuCI 包要升 `PKG_VERSION`。
- 产出 `<dir>/aarch64_cortex-a53/`：两个 ipk、`Packages`、`Packages.gz`、`Packages.manifest`、`Packages.sig`。签名必须用 `cfddns.pub` 校验通过才会生成；缺工具、缺私钥或私钥在 `<dir>` 里都直接失败。

CI（`.github/workflows/feed.yml`）：每次 push / PR 跑测试、shellcheck，并核对固定的核心哈希；push `main` 时用同一个 SDK 构建，用 secret `CFDDNS_FEED_SIGNING_KEY`（usign 私钥文件的内容）签名，再部署到 GitHub Pages。secret 缺失时直接失败，不发布未签名的索引。

升级核心：同时改 `net/network/cfddns/Makefile` 的 `PKG_VERSION` / `PKG_RELEASE` / `PKG_HASH`、workflow 的 `CORE_VERSION`，以及 `tests/` 里固定的版本和哈希；`make check` 核对它们一致。
