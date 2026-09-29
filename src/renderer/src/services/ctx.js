/**
 * 工具的统一入口。内置工具和按需下载的插件工具拿到的是同一个 ctx，
 * 这样插件的 SDK 契约从一开始就是真的，不是给内置工具开后门。
 */
export const ctx = {
  invoke: (channel, payload) => window.toolbox.invoke(channel, payload),
  on: (channel, listener) => window.toolbox.on(channel, listener),
  async call(channel, payload) {
    const res = await window.toolbox.invoke(channel, payload)
    if (!res || res.ok !== true) throw new Error((res && res.error) || `调用 ${channel} 失败`)
    return res.data
  },
}

export default ctx
