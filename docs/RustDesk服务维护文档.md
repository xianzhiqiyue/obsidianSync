# RustDesk 服务维护文档

## 1. 部署信息
- 服务器：`47.122.112.210`（Ubuntu 24.04.2 LTS）
- 部署时间：2026-02-26
- RustDesk Server 版本：`1.1.15`
- 安装方式：官方 `deb` 包（`hbbs` + `hbbr`）

## 2. 服务与目录
- systemd 服务：
  - `rustdesk-hbbs`（ID/Rendezvous）
  - `rustdesk-hbbr`（Relay）
- 可执行文件：
  - `/usr/bin/hbbs`
  - `/usr/bin/hbbr`
- 工作目录：
  - `/var/lib/rustdesk-server/`
- 日志目录：
  - `/var/log/rustdesk-server/`

## 3. 端口配置
- RustDesk 服务端口（已在 UFW 放行）：
  - `21115/tcp`
  - `21116/tcp`
  - `21116/udp`
  - `21117/tcp`
  - `21118/tcp`
- 说明：阿里云安全组也需要放行以上端口，否则客户端无法公网连接。

## 4. 客户端连接参数
- `ID Server`: `47.122.112.210`
- `Relay Server`: `47.122.112.210`
- `API Server`: 留空
- `Key`: 使用 `/var/lib/rustdesk-server/id_ed25519.pub` 内容

## 5. 日常运维命令
```bash
# 查看服务状态
systemctl status rustdesk-hbbs rustdesk-hbbr

# 启动/停止/重启
systemctl start rustdesk-hbbs rustdesk-hbbr
systemctl stop rustdesk-hbbs rustdesk-hbbr
systemctl restart rustdesk-hbbs rustdesk-hbbr

# 开机自启
systemctl enable rustdesk-hbbs rustdesk-hbbr

# 查看监听端口
ss -lntup | grep -E ':2111(5|6|7|8)'

# 查看日志
tail -f /var/log/rustdesk-server/hbbs.log
tail -f /var/log/rustdesk-server/hbbr.log
tail -f /var/log/rustdesk-server/hbbs.error
tail -f /var/log/rustdesk-server/hbbr.error
```

## 6. 升级步骤
```bash
# 1) 查询最新版本
VER=$(curl -fsSL https://api.github.com/repos/rustdesk/rustdesk-server/releases/latest | awk -F'"' '/tag_name/{print $4; exit}')

# 2) 下载 hbbs/hbbr 包
cd /tmp
curl -fLO https://github.com/rustdesk/rustdesk-server/releases/download/${VER}/rustdesk-server-hbbs_${VER}_amd64.deb
curl -fLO https://github.com/rustdesk/rustdesk-server/releases/download/${VER}/rustdesk-server-hbbr_${VER}_amd64.deb

# 3) 安装并重启
dpkg -i rustdesk-server-hbbs_${VER}_amd64.deb rustdesk-server-hbbr_${VER}_amd64.deb
systemctl restart rustdesk-hbbs rustdesk-hbbr
systemctl status rustdesk-hbbs rustdesk-hbbr
```

## 7. 密钥备份与轮换
```bash
# 备份当前密钥（强烈建议）
cp /var/lib/rustdesk-server/id_ed25519 /root/id_ed25519.bak
cp /var/lib/rustdesk-server/id_ed25519.pub /root/id_ed25519.pub.bak
chmod 600 /root/id_ed25519.bak

# 轮换密钥（会导致客户端需更新 Key）
systemctl stop rustdesk-hbbr rustdesk-hbbs
rm -f /var/lib/rustdesk-server/id_ed25519 /var/lib/rustdesk-server/id_ed25519.pub
systemctl start rustdesk-hbbs
systemctl start rustdesk-hbbr

# 查看新公钥
cat /var/lib/rustdesk-server/id_ed25519.pub
```

## 8. 故障排查
- 服务不启动：
  - `journalctl -u rustdesk-hbbs -n 200 --no-pager`
  - `journalctl -u rustdesk-hbbr -n 200 --no-pager`
- 客户端连接失败：
  - 检查 UFW 规则：`ufw status`
  - 检查阿里云安全组入站端口是否放行
  - 检查服务端口监听：`ss -lntup | grep 2111`
- 客户端显示 Key 不匹配：
  - 确认客户端填入的是当前 `id_ed25519.pub` 内容
  - 若轮换过密钥，需在所有客户端更新 Key
