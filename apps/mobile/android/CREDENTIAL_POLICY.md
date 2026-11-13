# Android 发布凭证与签名安全规范 (Signing & Credential Policy)

> **生效日期**：2026-11-14  
> **保密级别**：Strictly Confidential (离线受控)  
> **审查人**：yjxk2021 (Peer Reviewer) & yjxk2013-source (Lead Architect)

---

## 1. 签名凭证物理隔离原则
- 本项目的 Android 发布签名凭证属于企业最高级商业凭证，**严禁提交入代码版本库**；
- 生产 App 签名采用离线物理隔离介质与 KMS/CI Secrets 动态注入，不落盘、不留存；
- CI/CD 自动化打包统一通过 CI Secrets 环境变量（`ANDROID_KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`）安全装配。

## 2. 历史密钥吊销与废弃声明 (Key Revocation Notice)
- **作废声明**：历史测试提交中曾存在之旧签名证书（`jansee-release.keystore`）与临时测试订单历史文件已于 2026-11-14 00:00 起**正式宣布全面作废与永久吊销**；
- **防护机制**：各应用分发平台与包体校验服务已将旧证书指纹列入黑名单，历史证书已丧失任何有效性；
- **全历史净化**：全仓库历史提交通过 `git filter-repo` / `git filter-branch` 完成全量深层净化，物理剔除所有历史敏感凭证对象；
- **下游克隆重置指引**：所有协作者与下游克隆方需执行 `git fetch --force --prune && git reset --hard origin/main` 重新拉取不可变干净提交历史。

## 3. 敏感数据与运行时隔离
- 严禁任何真实业务订单、支付凭据与用户会话数据（`apps/web/server/data/*.json`）提交入库；
- `.gitignore` 已实施硬规则拦截（`*.keystore`、`*.jks`、`apps/web/server/data/*.json`），严防任何泄漏回潮。
