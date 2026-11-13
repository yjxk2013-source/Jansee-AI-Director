# Android 发布凭证与签名安全规范 (Signing & Credential Policy)

> **生效日期**：2026-11-14  
> **保密级别**：Strictly Confidential (离线受控)

---

## 1. 签名凭证物理隔离原则
- 本项目的 Android 发布签名凭证 (`jansee-release.keystore`) 属于企业最高级商业凭证，**严禁提交入代码版本库**；
- 历史废弃测试凭证已完成轮换（Key Rotation），生产 App 签名采用离线物理隔离介质管理；
- CI/CD 自动化打包通过 GitHub Secrets 环境变量（`ANDROID_KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`）动态注入，不落盘、不留存。
