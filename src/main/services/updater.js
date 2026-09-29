import { app, shell } from 'electron'
import updaterPkg from 'electron-updater'
import { read as readSettings } from './settings.js'

// electron-updater 是 CJS，主进程跑在 ESM 下：具名 import 会在运行时抛
// "Named export 'autoUpdater' not found"（构建期发现不了，只有真正加载才炸）
const { autoUpdater } = updaterPkg

export const RELEASE_PAGE = 'https://github.com/1263229887/toolbox-desktop/releases'

/**
 * 更新只做三件事：查、下、装。不静默下载——未签名的包在国内网络下动辄几十 MB，
 * 而且差量能否命中取决于本地是否留着上次的安装包，得让用户看到进度。
 *
 * feed 走 GitHub provider；设置里填了 updateFeedUrl 就改成 generic（将来切境外
 * OSS/COS 默认域名时只改这个值，latest.yml 与产物同目录即可，代码不用动）。
 */
export function initUpdater(emit) {
  if (!app.isPackaged) {
    const idle = async () => emit({ state: 'idle', message: '开发环境不检查更新' })
    emit({ state: 'idle', message: '开发环境不检查更新' })
    // 开发态也返回同一组方法，UI 不用为「现在能不能点」写分支
    return { check: idle, download: idle, quitAndInstall: idle, openReleasePage: idle }
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // 差量下载依赖 blockmap + 本地缓存的上一个安装包，缺任一项 electron-updater 自己会退回全量
  autoUpdater.on('error', (e) => emit({ state: 'error', message: e.message }))
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => emit({ state: 'available', version: i.version, note: i.releaseNotes || '', message: `发现新版本 ${i.version}` }))
  autoUpdater.on('update-not-available', (i) => emit({ state: 'up-to-date', version: i.version, message: '已是最新版本' }))
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total }))
  autoUpdater.on('update-downloaded', (i) => emit({ state: 'downloaded', version: i.version, message: `v${i.version} 已下载，重启后生效` }))

  const applyFeed = async () => {
    const cfg = await readSettings()
    if (cfg.updateFeedUrl) {
      const url = cfg.updateFeedUrl.endsWith('/') ? cfg.updateFeedUrl : `${cfg.updateFeedUrl}/`
      autoUpdater.setFeedURL({ provider: 'generic', url })
    } else {
      autoUpdater.setFeedURL({ provider: 'github', owner: '1263229887', repo: 'toolbox-desktop', releaseType: 'release' })
    }
  }

  return {
    async check() {
      await applyFeed()
      return autoUpdater.checkForUpdates()
    },
    async download() {
      return autoUpdater.downloadUpdate()
    },
    quitAndInstall() {
      autoUpdater.quitAndInstall(false, true)
    },
    openReleasePage() {
      return shell.openExternal(RELEASE_PAGE)
    },
  }
}
