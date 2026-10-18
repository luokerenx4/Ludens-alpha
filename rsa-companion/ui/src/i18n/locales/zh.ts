// Pet settings translations copied from OpenAlice.
export const messages = {
  pet: {
    title: '桌宠', sound: '点击音效',
    description: '自定义桌宠的点击音效。拖动时保持安静，设置仅保存在这台设备上。',
    enabled: '点击时播放音效', volume: '音量', file: '音效文件',
    noFile: '尚未选择音效，点击时不会播放声音。',
    fileHelp: 'WAV、MP3 或 OGG，最大 2 MB、最长 10 秒。文件会复制到本机，不会上传。',
    choose: '选择音频…', preview: '试听', reset: '恢复默认',
    resetHelp: '恢复默认会回到 OpenAlice 内置的软糯双响，并将音量重置为 50%。关闭点击音效后仍可试听。',
    loading: '正在加载桌宠设置…', saving: '正在保存…',
    desktopOnly: '启用桌宠后，可在桌面应用中配置音效。',
    error: { unavailable: '桌宠设置暂不可用，请重新打开此页面。', invalidFile: '请选择可播放的 WAV、MP3 或 OGG 文件，最大 2 MB、最长 10 秒。', failed: '无法保存桌宠设置，请重试。', playback: '无法播放此音频，请选择其他文件。' },
  },
  activityPreferences: {
    title: '活动通知', description: '选择 Alice 展示的日志内容，完整运行记录不受影响。', desktopOnly: '通知偏好仅在桌面应用中可用。',
    enabled: '自动通知', main: '气泡不可用时显示窗口通知', pet: 'Alice 气泡', brief: '隐私气泡 · 仅展示简短状态', blocks: '可见日志内容',
    block: { thinking: '思考', text: '文本', tool: '工具调用', system: '系统事件', diagnostic: '诊断详情' },
    pause: '暂停 1 小时', resume: '恢复通知', reset: '恢复内容默认值', paused: '已暂停至 {{time}}。',
    local: '保存在当前桌面设备。桌宠显示单独控制。恢复默认值会重置内容开关，保留显示与暂停设置。', error: '无法加载或保存通知偏好，已确认的设置保留。请重试。',
  },
}
