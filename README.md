# QQ机器人 Windows 接管包

继续使用原机器人QQ，不需要新建号码。

[直接下载 deliverables_HuangZiming_Windows.zip](https://github.com/lao-boop/ojj-qq-agent/raw/refs/heads/deliverables/windows-takeover-20261120/deliverables_HuangZiming_Windows.zip)

完整代码版本：`5b45402865c41cd9296d6c370163ccef80c3fdc5`，分支 `fix/windows-friend-test-bundle`。main未修改。

先打开包内START_HERE.txt。[详细交接步骤](WINDOWS-HANDOVER.md)。

公开包包含完整代码、Windows安装/启动/检查工具、配置模板、依赖清单、测试和历史报告。真实密钥与历史数据由原主人在Mac上单独本地导出，私下交给新主人；不在本公开包里。QQ接入程序须另装，现有QQ的登录需双方完成。

验证：Linux云环境250项Node测试、5项Python测试通过；解压到新目录并npm ci后，20项本地迁移与入口测试通过。没有在Windows实机登录QQ；第三方QQ接入程序的旧下载入口可用性见详细说明。
