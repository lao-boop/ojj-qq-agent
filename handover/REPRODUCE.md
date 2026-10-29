# 本地复现

本轮环境为Linux、Node.js 24.19、Python 3.12；Node测试需要本地临时端口权限与ffmpeg。Office预览还需LibreOffice及中文字体（如Noto Sans CJK）。

在交接包根目录：

```bash
python3 tools/validate_handover.py .
cd apps/ojj-qq-agent
npm ci --ignore-scripts
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
node --test --test-concurrency=1 tests/*.test.js
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
```

依赖安装完成后，也可在包根运行 `bash scripts/run_checks.sh`。不需要模型密钥，不连接真实QQ。本次实际验证是否复用了宿主依赖，见 evidence/PACKAGE_VERIFICATION.json。

真实模型新测试需要安全设置 `DEEPSEEK_API_KEY`，在应用目录执行：

```bash
node --use-env-proxy --use-system-ca scripts/evaluate_response_quality.mjs \
  --live --real-memory --suite=scripts/task-reliability-reserve-cases.mjs \
  --out=tmp/my-new-run
node scripts/response-quality-report.mjs tmp/my-new-run
```

这套题已公开，再跑属于回归测试。检验泛化需要另建未使用过的题库；复跑不会自动生成内容评分，仍需复核 reviews.json。旧代码快照未放入本包，因此历史前后对比不能仅靠当前源码重建；已有结果和哈希完整保留。

实际启动机器人时，复制 config.example.json 为 config.json，在本地安全填写OneBot和模型配置后运行 `npm start`。运行配置与云评测环境变量不同；`node scripts/check_runtime_profile.mjs` 只读检查配置。其他语音服务的可选依赖见 requirements-multimodal.txt。不要将配置或数据目录作为分享材料。
