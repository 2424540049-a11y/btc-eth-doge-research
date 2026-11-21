# BTC、ETH、DOGE 策略研究台

在网页里查看币安公开行情并回放交易策略。由 GitHub Pages 提供静态资源。计算在访问者的浏览器中运行，手机和电脑均可使用。

## 使用

- “行情研究”提供现货、永续成交价、标记价与实际资金费，可切换小时、4 小时、日和周线，浏览或导出选定区间。
- “策略回测”提供日线均衡、4 小时半仓、可调窗口轮动、可调双均线和现货持有。两个参考实验涵盖 2025-01-01 至 2026-10-27。买卖均为历史模拟。
- 自建实验保存在当前浏览器，可将参数、逐笔成交及净值导出。换设备时需另行保留导出文件。

## 公开数据

本版行情截至 2026-11-20 UTC。583,878 根小时 K 线涵盖三币的现货、永续和标记价格，另有 22,512 条资金费结算。每条数据流的覆盖与缺口均可在“数据管理”中查阅。使用近期版本的 Chrome、Edge、Firefox 或 Safari。

数据以按币种、年份和类型划分的压缩文件提供，目录和校验值在 [快照清单](data/manifest.json)。历史行情来自 [Binance 官方归档](https://github.com/binance/binance-public-data) 及 [Binance 官方公共接口](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)。
