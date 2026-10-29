# cfddns-openwrt

[cfddns](https://github.com/xjetry/cfddns) 的 OpenWrt 软件源（opkg feed），两个包：

- `cfddns`：核心，UCI（`/etc/config/cfddns`）+ procd 服务；直接打包 cfddns v0.3.0 Release 的 `cfddns-linux-arm64`（静态链接，SHA256 固定），架构 `aarch64_cortex-a53`
- `luci-app-cfddns`：LuCI 页面（服务 → Cloudflare DDNS），「运行状态」「基本设置」两个标签页，架构 `all`

软件源：`https://xjetry.github.io/cfddns-openwrt/aarch64_cortex-a53`

索引用 usign 签名，公钥 [`cfddns.pub`](cfddns.pub)，指纹 `af1661a3e9bf4ee0`。

---

## 支持范围

| 设备 | 固件 | 状态 |
|------|------|------|
| GL-E5800 / Mudi 7 | GL 原厂固件，OpenWrt 23.05.4（`sdx75/generic`） | 待真机验收 |
| GL-BE10000 / Slate 7 Pro | GL 原厂固件 4.8.6，OpenWrt 21.02（`mediatek/mt7987`） | 待真机验收 |

两台的 opkg 都接受 `aarch64_cortex-a53`。包用官方 OpenWrt 23.05.4 `mediatek/filogic` SDK 打包，不是 GL 的厂商 SDK。真机验收完成前不算已支持；其他设备即使架构匹配也未验证，不要靠强改 opkg 架构安装。

---

## 安装

> 在路由器上以 root 执行。

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

安装：

```sh
opkg install luci-app-cfddns     # 页面 + 核心，自动带上 cfddns 和 ca-bundle
opkg install cfddns              # 只要核心：UCI + 服务，没有页面
```

### 校验索引签名

`/etc/opkg.conf` 里有 `option check_signature` 时，`opkg update` 自己校验 `Packages.sig`，签名不对就拒绝这个源。GL 原厂固件默认没有这一行，opkg 不校验签名。不要为此改 `opkg.conf`，装之前手动校验 opkg 刚下载的索引：

```sh
wget -O /tmp/cfddns-Packages.sig https://xjetry.github.io/cfddns-openwrt/aarch64_cortex-a53/Packages.sig
usign -V -m /var/opkg-lists/cfddns -x /tmp/cfddns-Packages.sig -P /etc/opkg/keys
```

`/var/opkg-lists` 是 `opkg.conf` 里 `lists_dir` 的默认值。输出 `OK` 才安装。索引里有每个 ipk 的 SHA256，opkg 下载时会核对。校验失败先重新 `opkg update` 再校验一次（可能刚好赶上发布），仍失败就不要安装。

---

## 配置

`/etc/config/cfddns`（UCI）是唯一配置来源，用 LuCI 页面或 `uci` 修改：

| 选项 | 默认 | 说明 |
|------|------|------|
| `enabled` | `0` | `1` 运行并开机自启 |
| `domain_v4` | — | IPv4 域名（A） |
| `domain_v6` | — | IPv6 域名（AAAA） |
| `v6_iface` | — | IPv6 取该网卡的稳定地址；需要同时设 `domain_v6` |
| `token` | — | **必填** Cloudflare API Token（`Zone:DNS:Edit` + `Zone:Zone:Read`） |
| `period` | `5m` | 更新周期，最小 `10s` |

`domain_v4` / `domain_v6` 至少一个。命令行：

```sh
uci set cfddns.main.domain_v4=home.example.com
uci set cfddns.main.token='YOUR_CF_TOKEN'
uci set cfddns.main.enabled=1
uci commit cfddns
/etc/init.d/cfddns enable
/etc/init.d/cfddns reload        # 重新生成 env；enabled=1 重启，enabled=0 停止
```

`/etc/cfddns.env` 由 `/usr/libexec/cfddns-config` 从 UCI 生成（`0600`），每次 start / reload 覆盖：不要手改，也不要 `source` / `.` 它，Token 里可能有 `$`、反引号等字符。

运行状态：LuCI「运行状态」标签页，或 `/var/run/cfddns.status`；日志 `logread -e cfddns`。

卸载：`opkg remove luci-app-cfddns cfddns`（同时删除 `/etc/cfddns.env`）。

---

## 从 install.sh / `-install` 迁移

`cfddns` 包首次安装时，只要 `/usr/bin/cfddns`、`/etc/init.d/cfddns`、`/etc/cfddns.env` 任一存在（包括失效的符号链接）就中止安装：不覆盖、不接管手动安装，也不导入旧配置。先卸载手动安装：

```sh
cp -p /etc/cfddns.env /root/cfddns.env.bak   # 备份，含 Token
cfddns -uninstall                            # 停服务，删 init 脚本 / env / 二进制
opkg install luci-app-cfddns                 # 或 opkg install cfddns
```

然后按备份里的 `CFDDNS_V4` / `CFDDNS_V6` / `CFDDNS_V6_IFACE` / `CFDDNS_TOKEN` / `CFDDNS_PERIOD` 填 UCI，确认运行正常后删除备份。手动安装的 `-port` / `-passwd` HTTP 触发在包里没有对应选项。

---

## 构建与发布

```sh
make check      # shell / JS / feed 测试，需要 node
make feed SDK_DIR=<sdk> CORE_VERSION=0.3.0 OUTPUT_DIR=<dir> FEED_KEY=<usign 私钥>
```

- `SDK_DIR`：OpenWrt 23.05.4 `mediatek/filogic` SDK（x86_64 Linux，非 root 运行）。`feeds.conf` 会被替换成本仓库（`src-link`）加 SDK 自带的 luci feed。
- 核心包不编译 Go：SDK 下载 Release 的 `cfddns-linux-arm64` 并按 `PKG_HASH` 校验，打包后再核对 ipk 里的 `/usr/bin/cfddns`。
- LuCI 包不压缩 JS，构建后核对其中每个文件都与 `luci/applications/luci-app-cfddns` 逐字节一致。`luci.mk` 只用 `PKG_VERSION` 作版本（不带 `PKG_RELEASE`），改 LuCI 包要升 `PKG_VERSION`。
- 产出 `<dir>/aarch64_cortex-a53/`：两个 ipk、`Packages`、`Packages.gz`、`Packages.manifest`、`Packages.sig`。签名必须用 `cfddns.pub` 校验通过才会生成；缺工具、缺私钥或私钥在 `<dir>` 里都直接失败。

CI（`.github/workflows/feed.yml`）：每次 push / PR 跑测试、shellcheck，并核对固定的核心哈希；push `main` 时用同一个 SDK 构建，用 secret `CFDDNS_FEED_SIGNING_KEY`（usign 私钥文件的内容）签名，再部署到 GitHub Pages。secret 缺失时直接失败，不发布未签名的索引。

升级核心：同时改 `net/network/cfddns/Makefile` 的 `PKG_VERSION` / `PKG_HASH` 和 workflow 的 `CORE_VERSION`。
