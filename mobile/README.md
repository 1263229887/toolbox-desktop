# mobile — 桌面工具箱的移动端(uni-app x · 蒸汽模式)

目前只有「解析」一个功能:粘贴抖音分享口令,取回无水印图片/视频并可保存到相册。
桌面上重一点的工具(Word/PDF 等)不会搬到手机上。

## 怎么跑起来

1. 装 [HBuilderX / HBuilder 5.25+](https://www.dcloud.io/hbuilderx.html)(5.25 起新项目默认就是蒸汽模式;入口脚本 ts 后缀需要 5.31+)。
2. 文件 → 导入 → 从本地目录导入,选本目录(`mobile/`)。**本目录就是项目根**,代码必须在根下(uni-app x 不支持 src/dist 结构)。
3. 运行 → 运行到手机或模拟器(标准基座即可,本应用不依赖自定义原生插件);也可以先「运行到 web」快速看界面。
4. `appid` 留空即可,HBuilderX 首次云打包时会自动生成。

## 代码约定

- 蒸汽模式:页面全部用 **vue3 + ts/js** 写(不写 uts 原生语法);`main.uts` 后缀保留是历史习惯,内容就是普通 ts。
- 解析链路和桌面端 `src/main/services/douyin.js` 同构:demo 实例登录拿会话 cookie → 提交 parse 任务(202+task_id)→ 轮询直到 done;风控报错(`UPSTREAM_RISK_CONTROL`)原样透出。上游契约的实测记录见仓库 `docs/进行中方案.md`。
- demo 实例地址目前写死在 `pages/index/index.uvue` 的 `DEMO_HOST`,后续加设置页再抽出来。

## 真机待验证(桌面端验证过、移动端还没验的点)

- douyinpic/zjcdn 的媒体直链在原生 image/video 组件下能否直接加载(桌面端 Electron 给媒体请求改写过 Referer;原生组件默认不带 Referer,按实测视频 play 端点裸请求可用,图片端点大概率也没问题,但要真机确认)。
- 保存到相册的权限:Android 上 `saveImageToPhotosAlbum/saveVideoToPhotosAlbum` 若报权限错误,在 manifest.json 里补 `app-android` 相关 permissions 再用自定义基座跑。

## 后续规划:传输助手(手机 ↔ 电脑)

类似微信文件传输助手:手机和电脑在局域网内互发文字/图片/文件,**只做会话级,不落盘持久化,退出即失效**;两端都是聊天窗口形态。协议与落点设计见仓库 `docs/进行中方案.md` 的「传输助手」一节。
